import http from "node:http";
import fetch from "node-fetch";

import { retryAfterMs } from "../lib/llm_health_check.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("LLM Health Check", function () {
  var port = 9300;
  var upstreamPort = 9310;
  var geminiPort = 9320;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var upstreamServer;
  var geminiServer;
  var upstreamRequests;
  var upstreamHandler;
  var currentProxy;

  beforeEach(function () {
    upstreamRequests = [];
    upstreamHandler = function (req, res) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_probe" }));
    };
  });

  afterEach(async function () {
    if (currentProxy && currentProxy.llmHealth) {
      await currentProxy.llmHealth.close();
      currentProxy = null;
    }
    for (var server of [upstreamServer, geminiServer]) {
      if (server) server.close();
    }
    upstreamServer = null;
    geminiServer = null;
    await new Promise(function (resolve) {
      util.teardownServers(resolve);
    });
  });

  function startUpstream(targetPort) {
    return new Promise(function (resolve) {
      var server = http.createServer(function (req, res) {
        var body = "";
        req.on("data", function (chunk) {
          body += chunk;
        });
        req.on("end", function () {
          upstreamRequests.push({
            port: targetPort,
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: body,
          });
          upstreamHandler(req, res, body);
        });
      });
      server.listen(targetPort, "127.0.0.1", function () {
        resolve(server);
      });
    });
  }

  async function setupHealthProxy(extraOptions) {
    upstreamServer = await startUpstream(upstreamPort);
    var options = Object.assign(
      {
        anthropicProxyPath: "/anthropic",
        anthropicApiUrl: "http://127.0.0.1:" + upstreamPort,
        anthropicApiKey: "real-anthropic-key",
        anthropicProbeModel: "claude-test",
        llmHealthProbeTimeout: 1500,
      },
      extraOptions || {}
    );
    currentProxy = await util.setupProxy(listenOptions, options, []);
    return currentProxy;
  }

  // 등록된 pod IP(127.0.0.1)로 인식되도록 user 라우트를 등록한다.
  function registerUserRoute(proxy) {
    return proxy.addRoute("/user/testuser", {
      target: "http://127.0.0.1:" + (port + 2),
    });
  }

  function getHealth() {
    return fetch(proxyUrl + "/llm_health_check");
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  it("disabled when no llm api proxy is configured", async function () {
    currentProxy = await util.setupProxy(listenOptions, {}, []);
    var res = await getHealth();
    expect(res.status).toEqual(404);
  });

  it("rejects requests from unregistered IPs", async function () {
    await setupHealthProxy();
    var res = await getHealth();
    expect(res.status).toEqual(403);
  });

  it("rejects non-GET methods", async function () {
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);
    var res = await fetch(proxyUrl + "/llm_health_check", { method: "POST" });
    expect(res.status).toEqual(405);
  });

  it("reports healthy provider under opencode-style key", async function () {
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var res = await getHealth();
    expect(res.status).toEqual(200);
    var body = await res.json();
    expect(body.models["anthropic/claude-test"]).toEqual({ status: "healthy" });

    expect(upstreamRequests.length).toEqual(1);
    var probe = upstreamRequests[0];
    expect(probe.method).toEqual("POST");
    expect(probe.url).toEqual("/v1/messages");
    expect(probe.headers["x-api-key"]).toEqual("real-anthropic-key");
    expect(probe.headers["anthropic-version"]).toEqual("2023-06-01");
    var probeBody = JSON.parse(probe.body);
    expect(probeBody.model).toEqual("claude-test");
    expect(probeBody.max_tokens).toEqual(1);
  });

  it("serves cached state within ttl without re-probing", async function () {
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    await getHealth();
    var res = await getHealth();
    var body = await res.json();
    expect(body.models["anthropic/claude-test"].status).toEqual("healthy");
    expect(upstreamRequests.length).toEqual(1);
  });

  it("re-probes after ttl expiry", async function () {
    var proxy = await setupHealthProxy({ llmHealthTtl: 200 });
    await registerUserRoute(proxy);

    await getHealth();
    await sleep(300);
    await getHealth();
    expect(upstreamRequests.length).toEqual(2);
  });

  it("coalesces concurrent polls into a single probe", async function () {
    upstreamHandler = function (req, res) {
      setTimeout(function () {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "msg_probe" }));
      }, 200);
    };
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var responses = await Promise.all([getHealth(), getHealth(), getHealth(), getHealth(), getHealth()]);
    for (var res of responses) {
      var body = await res.json();
      expect(body.models["anthropic/claude-test"].status).toEqual("healthy");
    }
    expect(upstreamRequests.length).toEqual(1);
  });

  it("reports unhealthy on upstream 5xx", async function () {
    upstreamHandler = function (req, res) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error" } }));
    };
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"]).toEqual({ status: "unhealthy" });
  });

  it("reports unhealthy on probe timeout", async function () {
    upstreamHandler = function (req, res) {
      setTimeout(function () {
        res.writeHead(200);
        res.end("{}");
      }, 1000);
    };
    var proxy = await setupHealthProxy({ llmHealthProbeTimeout: 300 });
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"]).toEqual({ status: "unhealthy" });
  });

  it("reports rate_limited on 429 and skips probing until expiry", async function () {
    upstreamHandler = function (req, res) {
      res.writeHead(429, { "Content-Type": "application/json", "retry-after": "60" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
    };
    var proxy = await setupHealthProxy({ llmHealthTtl: 100 });
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("rate_limited");

    // rate_limited 유지 중에는 TTL 이 지나도 프로브하지 않는다
    await sleep(200);
    body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("rate_limited");
    expect(upstreamRequests.length).toEqual(1);
  });

  it("uses rate limit ttl without retry-after and re-probes after expiry", async function () {
    var rateLimited = true;
    upstreamHandler = function (req, res) {
      if (rateLimited) {
        rateLimited = false;
        res.writeHead(429);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "msg_probe" }));
    };
    var proxy = await setupHealthProxy({ llmHealthRateLimitTtl: 300 });
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("rate_limited");

    await sleep(400);
    body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("healthy");
    expect(upstreamRequests.length).toEqual(2);
  });

  it("treats rate_limit error body as rate_limited", async function () {
    upstreamHandler = function (req, res) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
    };
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("rate_limited");
  });

  it("treats error body on 200 as unhealthy", async function () {
    upstreamHandler = function (req, res) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
    };
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("unhealthy");
  });

  it("marks provider rate_limited from real traffic 429 without probing", async function () {
    upstreamHandler = function (req, res) {
      res.writeHead(429, { "Content-Type": "application/json", "retry-after": "60" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
    };
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var trafficRes = await fetch(proxyUrl + "/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "dummy", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-real", messages: [] }),
    });
    expect(trafficRes.status).toEqual(429);
    // noteTrafficRateLimit 은 fire-and-forget 이라 기록 완료를 잠깐 기다린다
    await sleep(100);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("rate_limited");
    expect(upstreamRequests.length).toEqual(1);
  });

  it("keeps traffic rate_limited over a concurrent healthy probe result", async function () {
    upstreamHandler = function (req, res) {
      setTimeout(function () {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "msg_probe" }));
      }, 300);
    };
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var pending = getHealth();
    await sleep(100);
    proxy.llmHealth.noteTrafficRateLimit("anthropic", { "retry-after": "60" });
    var body = await (await pending).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("rate_limited");
  });

  it("returns unknown when another replica holds the probe lock and no state exists", async function () {
    var proxy = await setupHealthProxy();
    await registerUserRoute(proxy);

    var client = await proxy.llmHealth._client();
    await client.set(proxy.llmHealth.lockKeyPrefix + "anthropic", "1");

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("unknown");
    expect(upstreamRequests.length).toEqual(0);
  });

  it("reports every configured provider with its own probe format", async function () {
    geminiServer = await startUpstream(geminiPort);
    var proxy = await setupHealthProxy({
      geminiProxyPath: "/gemini",
      geminiApiUrl: "http://127.0.0.1:" + geminiPort,
      geminiApiKey: "real-gemini-key",
      geminiProbeModel: "gemini-test",
    });
    await registerUserRoute(proxy);

    var body = await (await getHealth()).json();
    expect(body.models["anthropic/claude-test"].status).toEqual("healthy");
    expect(body.models["google/gemini-test"].status).toEqual("healthy");
    expect(Object.keys(body.models).length).toEqual(2);

    var geminiProbe = upstreamRequests.find(function (r) {
      return r.port === geminiPort;
    });
    expect(geminiProbe.url).toEqual("/v1beta/models/gemini-test:generateContent");
    expect(geminiProbe.headers["x-goog-api-key"]).toEqual("real-gemini-key");
    var geminiBody = JSON.parse(geminiProbe.body);
    expect(geminiBody.generationConfig.maxOutputTokens).toEqual(1);
  });
});

describe("LLM Health Check retry-after", function () {
  it("resolves rate limit duration with opencode retry-after priority", function () {
    expect(retryAfterMs({ "retry-after-ms": "1500", "retry-after": "60" }, 60000)).toEqual(1500);
    expect(retryAfterMs({ "retry-after": "2.5" }, 60000)).toEqual(2500);
    var untilMs = retryAfterMs({ "retry-after": new Date(Date.now() + 5000).toUTCString() }, 60000);
    expect(untilMs).toBeGreaterThan(0);
    expect(untilMs).toBeLessThanOrEqual(5000);
    expect(retryAfterMs({}, 60000)).toEqual(60000);
  });
});
