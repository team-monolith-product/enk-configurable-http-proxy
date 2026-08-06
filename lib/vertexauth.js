import { GoogleAuth } from "google-auth-library";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Vertex 는 정적 API 키를 받지 않고 수명이 짧은 OAuth 액세스 토큰만 받는다. 조직 정책
// iam.managed.disableServiceAccountApiKeyCreation 이 allowedServices 를 Gemini 로 한정해
// API 키 경로 자체가 막혀 있기도 하다. 그래서 다른 provider 와 달리 요청 시점에 토큰을
// 발급해 Authorization 헤더로 넣는다. 캐시와 만료 전 갱신은 google-auth-library 가 한다.
export class VertexTokenSource {
  constructor(credentials) {
    this.projectId = credentials.project_id;
    this.clientEmail = credentials.client_email;
    this._auth = new GoogleAuth({ credentials: credentials, scopes: [CLOUD_PLATFORM_SCOPE] });
    this._clientPromise = null;
  }

  async authorizationHeader() {
    if (!this._clientPromise) {
      this._clientPromise = this._auth.getClient();
    }
    var client;
    try {
      client = await this._clientPromise;
    } catch (e) {
      // 실패한 클라이언트를 캐시에 남기면 이후 요청이 영구히 같은 오류를 반복한다.
      this._clientPromise = null;
      throw e;
    }
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
    throw new Error('VERTEX_SA_KEY is not a service account key (type="' + credentials.type + '")');
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
    location === "global" ? "aiplatform.googleapis.com" : location + "-aiplatform.googleapis.com";
  return (
    "https://" +
    host +
    "/v1/projects/" +
    projectId +
    "/locations/" +
    location +
    "/endpoints/openapi"
  );
}
