// LLM 프로바이더 헬스체커.
//
// opencode(singleuser pod)가 폴링하는 GET /llm_health_check 의 상태를 만든다.
// 상태는 healthy / rate_limited / unhealthy 3가지로, rate limit(429)은 프로바이더
// 장애가 아니라 API 키 쿼터 소진이라 회복 시점(retry-after 기반)과 대응이 달라
// 분리 관리한다. 판정·retry-after 해석은 opencode 의 에러 처리
// (session/retry.ts, provider/error.ts)와 동일 기준을 쓴다.
//
// CHP 는 다중 replica 라 상태를 Valkey 에 공유한다. 자체 타이머 없이 폴링이
// 왔을 때만(TTL 경과 시) 프로브하므로, opencode 가 폴링을 멈추면 프로브도 멈춘다.

import http from "node:http";
import https from "node:https";
import { GlideClient, Script, TimeUnit } from "@valkey/valkey-glide";

import { sentry } from "./sentry.js";

// 프로브 결과 쓰기 가드: 프로브가 도는 사이 실 트래픽 429 가 기록한, 아직
// 유효한 rate_limited 를 프로브의 healthy 결과가 덮지 않는다.
const WRITE_PROBE_RESULT_SCRIPT = new Script(
  `
local new = cjson.decode(ARGV[2])
if new.status ~= 'rate_limited' then
  local cur = redis.call('HGET', KEYS[1], ARGV[1])
  if cur then
    local ok, decoded = pcall(cjson.decode, cur)
    if ok and decoded and decoded.status == 'rate_limited' and decoded.rateLimitedUntil
        and tonumber(decoded.rateLimitedUntil) > tonumber(ARGV[3]) then
      return 0
    end
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`.trim()
);

// opencode session/retry.ts delay() 와 동일한 우선순위:
// retry-after-ms(밀리초) > retry-after(초) > retry-after(HTTP-date) > 기본값
export function retryAfterMs(headers, defaultMs) {
  const retryAfterMsHeader = headers["retry-after-ms"];
  if (retryAfterMsHeader) {
    const parsedMs = Number.parseFloat(retryAfterMsHeader);
    if (!Number.isNaN(parsedMs)) return Math.ceil(parsedMs);
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const parsedSeconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(parsedSeconds)) return Math.ceil(parsedSeconds * 1000);
    const parsedDate = Date.parse(retryAfter) - Date.now();
    if (!Number.isNaN(parsedDate) && parsedDate > 0) return Math.ceil(parsedDate);
  }
  return defaultMs;
}

// opencode 준거 body 판정: too_many_requests / rate_limit 계열 코드는 rate limit,
// 그 외 error 형태(Overloaded, exhausted, unavailable 포함)는 전부 unhealthy.
export function classifyErrorBody(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== "object") return undefined;
  const err = json.error;
  if (json.type !== "error" && (err === undefined || err === null)) return undefined;
  const type = err && typeof err.type === "string" ? err.type : "";
  const code = err && typeof err.code === "string" ? err.code : "";
  if (type === "too_many_requests" || type.includes("rate_limit") || code.includes("rate_limit")) {
    return "rate_limited";
  }
  return "unhealthy";
}

export class LlmHealthChecker {
  constructor(options) {
    this.log = options.log;
    this.metrics = options.metrics;
    this.providers = options.providers;
    this.ttl = options.ttl || 30000;
    this.probeTimeout = options.probeTimeout || 10000;
    this.rateLimitTtl = options.rateLimitTtl || 60000;

    const u = new URL(options.valkeyUrl || process.env.VALKEY_URL);
    this._address = { host: u.hostname, port: parseInt(u.port, 10) };
    this._useTLS = u.protocol === "rediss:";
    const password = options.valkeyAuthToken || process.env.VALKEY_AUTH_TOKEN;
    this._credentials = password && { password };
    this._extraConfig = options.valkeyConfig || {};

    const keyPrefix = options.valkeyKeyPrefix || process.env.VALKEY_KEY_PREFIX || "chp";
    this.stateKey = `${keyPrefix}:llm_health`;
    this.lockKeyPrefix = `${keyPrefix}:llm_health_lock:`;

    this._inflight = new Map();
  }

  // 폴링이 없으면 연결도 필요 없으므로 첫 사용 시점에 연결한다.
  _client() {
    if (!this._clientPromise) {
      this._clientPromise = GlideClient.createClient({
        addresses: [this._address],
        useTLS: this._useTLS,
        ...(this._credentials ? { credentials: this._credentials } : {}),
        ...this._extraConfig,
      });
    }
    return this._clientPromise;
  }

  async close() {
    if (this._clientPromise) {
      const client = await this._clientPromise;
      client.close();
      this._clientPromise = null;
    }
  }

  async check() {
    const client = await this._client();
    const records = await client.hgetall(this.stateKey);
    const states = {};
    for (const { field, value } of records) {
      states[String(field)] = JSON.parse(String(value));
    }

    const now = Date.now();
    const models = {};
    await Promise.all(
      this.providers.map(async (provider) => {
        let entry = states[provider.providerID];
        if (!this._isFresh(entry, now)) {
          entry = await this._refresh(provider, entry);
        }
        models[`${provider.providerID}/${provider.probeModel}`] = this._present(entry);
      })
    );
    return { models };
  }

  // 실 트래픽에서 관측한 429. 모델별 쿼터라 프로브가 못 잡는 rate limit 을
  // 실사용 실패 1건 만에 메꾼다. 프록시 응답 경로를 막지 않도록 fire-and-forget.
  noteTrafficRateLimit(providerID, headers) {
    this._noteTrafficRateLimit(providerID, headers).catch((e) => {
      this.log.warn("llm health: failed to record traffic rate limit for %s: %s", providerID, e.message);
    });
  }

  async _noteTrafficRateLimit(providerID, headers) {
    const now = Date.now();
    const entry = {
      status: "rate_limited",
      checkedAt: now,
      rateLimitedUntil: now + retryAfterMs(headers || {}, this.rateLimitTtl),
      source: "traffic",
    };
    const client = await this._client();
    const prevJson = await client.hget(this.stateKey, providerID);
    const prev = prevJson ? JSON.parse(String(prevJson)) : undefined;
    await client.hset(this.stateKey, { [providerID]: JSON.stringify(entry) });
    this._recordStatus(providerID, prev && prev.status, entry);
  }

  // rate_limited 는 TTL 이 아니라 만료 시각으로만 관리한다: 유지 중엔 프로브를
  // 막고(쿼터 보호), 만료되면 checkedAt 과 무관하게 즉시 재프로브 대상이 된다.
  _isFresh(entry, now) {
    if (!entry) return false;
    if (entry.status === "rate_limited") return entry.rateLimitedUntil > now;
    return now - entry.checkedAt < this.ttl;
  }

  _refresh(provider, prevEntry) {
    let inflight = this._inflight.get(provider.providerID);
    if (!inflight) {
      inflight = this._probeWithLock(provider, prevEntry).finally(() => {
        this._inflight.delete(provider.providerID);
      });
      this._inflight.set(provider.providerID, inflight);
    }
    return inflight;
  }

  // replica 간 프로브 중복 방지. 락을 잡은 replica 만 프로브하고, 진 쪽은 저장된
  // (스테일) 상태로 즉시 응답한다 — 다음 폴에서 자연 보정. 락은 PX 만료로
  // 소유 replica 가 죽어도 자동 해제된다.
  async _probeWithLock(provider, prevEntry) {
    const client = await this._client();
    const lockKey = this.lockKeyPrefix + provider.providerID;
    const locked = await client.set(lockKey, "1", {
      conditionalSet: "onlyIfDoesNotExist",
      expiry: { type: TimeUnit.Milliseconds, count: this.probeTimeout + 2000 },
    });
    if (locked !== "OK") {
      const current = await client.hget(this.stateKey, provider.providerID);
      if (current) return JSON.parse(String(current));
      return { status: "unknown" };
    }
    try {
      const entry = await this._probe(provider);
      this.metrics.llmProbeCount.labels(provider.providerID, entry.status).inc();
      const written = await client.invokeScript(WRITE_PROBE_RESULT_SCRIPT, {
        keys: [this.stateKey],
        args: [provider.providerID, JSON.stringify(entry), String(Date.now())],
      });
      if (written === 0) {
        const current = await client.hget(this.stateKey, provider.providerID);
        if (current) return JSON.parse(String(current));
      }
      this._recordStatus(provider.providerID, prevEntry && prevEntry.status, entry);
      return entry;
    } finally {
      await client.del([lockKey]);
    }
  }

  _probe(provider) {
    return new Promise((resolve) => {
      const started = Date.now();
      const settle = (entry) => resolve(entry);

      if (!provider.apiKey) {
        this.log.error("llm health: %s probe skipped, %s not configured", provider.name, provider.envName);
        settle({
          status: "unhealthy",
          checkedAt: Date.now(),
          error: provider.envName + " not configured",
          source: "probe",
        });
        return;
      }

      const baseUrl = provider.apiUrl.replace(/\/+$/, "");
      let url, body;
      const headers = { "Content-Type": "application/json" };
      headers[provider.header] = provider.apiKey;
      if (provider.probeKind === "gemini") {
        url = baseUrl + "/v1beta/models/" + provider.probeModel + ":generateContent";
        body = JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        });
      } else {
        url = baseUrl + "/v1/messages";
        headers["anthropic-version"] = "2023-06-01";
        body = JSON.stringify({
          model: provider.probeModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        });
      }

      const request = (url.startsWith("https") ? https : http).request(
        url,
        { method: "POST", headers },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            if (size < 4096) {
              chunks.push(chunk);
              size += chunk.length;
            }
          });
          res.on("end", () => {
            settle(
              this._classify(
                provider,
                res.statusCode,
                res.headers,
                Buffer.concat(chunks).toString("utf8"),
                Date.now() - started
              )
            );
          });
        }
      );
      request.setTimeout(this.probeTimeout, () => {
        request.destroy(new Error("timeout after " + this.probeTimeout + "ms"));
      });
      request.on("error", (e) => {
        this.log.warn("llm health: %s probe failed: %s", provider.name, e.message);
        settle({ status: "unhealthy", checkedAt: Date.now(), error: e.message, source: "probe" });
      });
      request.end(body);
    });
  }

  _classify(provider, statusCode, headers, body, latencyMs) {
    const now = Date.now();
    const bodyClass = classifyErrorBody(body);
    if (statusCode === 429 || bodyClass === "rate_limited") {
      return {
        status: "rate_limited",
        checkedAt: now,
        rateLimitedUntil: now + retryAfterMs(headers, this.rateLimitTtl),
        source: "probe",
      };
    }
    if (statusCode >= 200 && statusCode < 300 && !bodyClass) {
      return { status: "healthy", checkedAt: now, latencyMs, source: "probe" };
    }
    const error = statusCode + " " + body.trim().slice(0, 256);
    if (statusCode >= 400 && statusCode < 500) {
      // 키 설정 오류(401/403)나 프로브 요청 결함 가능성 — 운영자가 즉시 알아야 함
      this.log.error("llm health: %s probe error: %s", provider.name, error);
    } else {
      this.log.warn("llm health: %s probe error: %s", provider.name, error);
    }
    return { status: "unhealthy", checkedAt: now, error, source: "probe" };
  }

  _recordStatus(providerID, prevStatus, entry) {
    for (const status of ["healthy", "rate_limited", "unhealthy"]) {
      this.metrics.llmProviderStatus.labels(providerID, status).set(entry.status === status ? 1 : 0);
    }
    if (prevStatus === entry.status) return;
    if (entry.status === "unhealthy") {
      this.log.error("llm health: %s %s -> unhealthy (%s)", providerID, prevStatus || "unknown", entry.error);
      sentry.captureLlmHealthTransition(providerID, prevStatus, "unhealthy", entry.error, "error");
    } else if (entry.status === "rate_limited") {
      this.log.warn("llm health: %s %s -> rate_limited until %s", providerID, prevStatus || "unknown", new Date(entry.rateLimitedUntil).toISOString());
      sentry.captureLlmHealthTransition(providerID, prevStatus, "rate_limited", entry.source, "warning");
    } else {
      this.log.info("llm health: %s %s -> healthy", providerID, prevStatus || "unknown");
    }
  }

  _present(entry) {
    if (!entry || entry.status === "unknown") return { status: "unknown" };
    const out = { status: entry.status, checkedAt: new Date(entry.checkedAt).toISOString() };
    if (entry.latencyMs !== undefined) out.latencyMs = entry.latencyMs;
    if (entry.error !== undefined) out.error = entry.error;
    if (entry.rateLimitedUntil !== undefined) {
      out.rateLimitedUntil = new Date(entry.rateLimitedUntil).toISOString();
    }
    if (entry.source) out.source = entry.source;
    return out;
  }
}
