import { GoogleAuth } from "google-auth-library";

import { trimPrefix } from "./trie.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Vertex 는 정적 API 키를 받지 않고 수명이 짧은 OAuth 액세스 토큰만 받는다. 조직 정책
// iam.managed.disableServiceAccountApiKeyCreation 이 allowedServices 를 Gemini 로 한정해
// API 키 경로 자체가 막혀 있기도 하다. 그래서 다른 provider 와 달리 요청 시점에 토큰을
// 발급해 Authorization 헤더로 넣는다.
//
// 클라이언트 캐시와 동시 요청 합류는 GoogleAuth.getClient 가, 액세스 토큰 캐시와 만료 전
// 갱신은 client.getAccessToken 이 이미 한다. 여기서 다시 감싸지 않는다.
export class VertexTokenSource {
  constructor(credentials) {
    this._auth = new GoogleAuth({ credentials: credentials, scopes: [CLOUD_PLATFORM_SCOPE] });
  }

  async authorizationHeader() {
    var client = await this._auth.getClient();
    var accessToken = await client.getAccessToken();
    if (!accessToken || !accessToken.token) {
      throw new Error("Vertex access token issuance returned an empty token");
    }
    return "Bearer " + accessToken.token;
  }
}

export function decodeServiceAccountKey(encoded) {
  // Buffer.from 은 잘못된 base64 에도 예외 없이 쓰레기 바이트를 돌려주므로, 검증은 아래
  // JSON 파싱과 필드 확인이 담당한다.
  var raw = Buffer.from(encoded, "base64").toString("utf8");

  var credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error("VERTEX_SA_KEY does not decode to valid JSON: " + e.message);
  }

  if (credentials.type !== "service_account") {
    throw new Error(`VERTEX_SA_KEY is not a service account key (type="${credentials.type}")`);
  }
  for (var field of ["project_id", "client_email", "private_key"]) {
    if (!credentials[field]) {
      throw new Error("VERTEX_SA_KEY is missing required field " + field);
    }
  }
  return credentials;
}

// location 이 global 이면 전역 엔드포인트를, 아니면 리전 엔드포인트를 쓴다.
export function defaultVertexApiUrl(projectId, location) {
  var host =
    location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${location}/endpoints/openapi`;
}

// apiProxies 에 넣을 Vertex 항목을 만든다. proxyPath 가 없으면 비활성이라 null 을 준다.
//
// 키가 없거나 깨졌으면 getAuthValue 없는 항목을 돌려준다. 여기서 throw 하면 전체 사용자
// 라우팅을 담당하는 팟이 crashloop 에 빠지므로, 다른 provider 의 키 미설정과 똑같이
// 요청 시점 500 으로 알린다.
export function createVertexProxy(options, log) {
  if (!options.vertexProxyPath) return null;

  var entry = {
    name: "Vertex",
    proxyPath: trimPrefix(options.vertexProxyPath),
    apiUrl: options.vertexApiUrl,
    header: "authorization",
    envName: "VERTEX_SA_KEY",
  };

  var credentials = null;
  if (!options.vertexServiceAccountKey) {
    log.error("Vertex proxy: VERTEX_SA_KEY not set, proxy path enabled but requests will fail");
  } else {
    try {
      credentials = decodeServiceAccountKey(options.vertexServiceAccountKey);
    } catch (e) {
      log.error("Vertex proxy: %s", e.message);
    }
  }
  if (!credentials) return entry;

  var location = options.vertexLocation || "global";
  var tokenSource = new VertexTokenSource(credentials);
  return {
    ...entry,
    apiUrl: options.vertexApiUrl || defaultVertexApiUrl(credentials.project_id, location),
    getAuthValue: () => tokenSource.authorizationHeader(),
  };
}
