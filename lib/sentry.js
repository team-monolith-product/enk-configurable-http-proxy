import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.ENVIRONMENT,
    // Http/NodeFetch 통합은 프록시를 지나는 모든 요청을 계측하므로 제외한다.
    integrations: (defaults) => defaults.filter((i) => i.name !== "Http" && i.name !== "NodeFetch"),
  });
}

export const sentry = {
  captureApiProxyResponse(provider, statusCode, method, url, body) {
    Sentry.captureMessage(provider + " API upstream error: " + statusCode, {
      level: "error",
      tags: { provider: provider, status_code: statusCode },
      extra: { method: method, url: url, body: body },
    });
  },
  captureApiProxyError(provider, e, method, url) {
    Sentry.captureException(e, {
      tags: { provider: provider },
      extra: { method: method, url: url },
    });
  },
  // 매 프로브 실패가 아니라 상태 전이 시에만 호출된다 — 노이즈 방지.
  captureLlmHealthTransition(provider, from, to, detail, level) {
    Sentry.captureMessage("LLM provider health: " + provider + " " + (from || "unknown") + " -> " + to, {
      level: level,
      tags: { provider: provider, health_to: to },
      extra: { from: from, detail: detail },
    });
  },
};
