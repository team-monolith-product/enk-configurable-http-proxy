import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Gemini API Proxy", function () {
  var port = 9220;
  var geminiPort = 9230;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var geminiServer;

  afterEach(function (callback) {
    if (geminiServer) {
      geminiServer.close();
      geminiServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockGeminiApi() {
    return new Promise(function (resolve) {
      geminiServer = http.createServer(function (req, res) {
        var body = "";
        req.on("data", function (chunk) {
          body += chunk;
        });
        req.on("end", function () {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write(
            JSON.stringify({
              url: req.url,
              method: req.method,
              apiKey: req.headers["x-goog-api-key"],
            })
          );
          res.end();
        });
      });
      geminiServer.listen(geminiPort, "127.0.0.1", function () {
        resolve(geminiServer);
      });
    });
  }

  function setupGeminiProxy(extraOptions) {
    var options = Object.assign(
      {
        geminiProxyPath: "/gemini",
        geminiApiUrl: "http://127.0.0.1:" + geminiPort,
        geminiApiKey: "real-gemini-key",
      },
      extraOptions || {}
    );
    return util.setupProxy(listenOptions, options, []);
  }

  function registerUserRoute(proxy) {
    return proxy.addRoute("/user/testuser", {
      target: "http://127.0.0.1:" + (port + 2),
    });
  }

  it("disabled when geminiProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/gemini/v1beta/models", {
        method: "GET",
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs", function (done) {
    setupGeminiProxy().then(function () {
      fetch(proxyUrl + "/gemini/v1beta/models", {
        method: "GET",
        headers: { "x-goog-api-key": "dummy" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        done();
      });
    });
  });

  it("proxies request from registered pod IP with key injection", function (done) {
    startMockGeminiApi().then(function () {
      setupGeminiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/gemini/v1beta/models/gemini-3.5-flash:generateContent", {
            method: "POST",
            headers: {
              "x-goog-api-key": "dummy",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ contents: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.apiKey).toEqual("real-gemini-key");
              expect(body.url).toEqual("/v1beta/models/gemini-3.5-flash:generateContent");
              done();
            });
        });
      });
    });
  });

  it("strips gemini proxy path prefix from URL", function (done) {
    startMockGeminiApi().then(function () {
      setupGeminiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse", {
            method: "POST",
            headers: { "x-goog-api-key": "dummy" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual(
                "/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse"
              );
              done();
            });
        });
      });
    });
  });

  it("does not intercept non-gemini paths", function (done) {
    setupGeminiProxy()
      .then(function (proxy) {
        return util.addTarget(proxy, "/", port + 2, false);
      })
      .then(function () {
        return fetch(proxyUrl + "/user/alice/test");
      })
      .then(function (res) {
        expect(res.status).not.toEqual(403);
        done();
      });
  });

  it("returns 500 when GEMINI_API_KEY is not configured", function (done) {
    setupGeminiProxy({ geminiApiKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/gemini/v1beta/models", {
          method: "GET",
          headers: { "x-goog-api-key": "dummy" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("replaces dummy apiKey with real key (dummy value not forwarded)", function (done) {
    startMockGeminiApi().then(function () {
      setupGeminiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/gemini/v1beta/models", {
            method: "GET",
            headers: { "x-goog-api-key": "proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.apiKey).toEqual("real-gemini-key");
              expect(body.apiKey).not.toEqual("proxy-auth");
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    geminiServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\n\n");
        res.write("data: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n");
        res.end();
      });
    });

    geminiServer.listen(geminiPort, "127.0.0.1", function () {
      setupGeminiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse", {
            method: "POST",
            headers: {
              "x-goog-api-key": "dummy",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ contents: [] }),
          }).then(function (res) {
            expect(res.status).toEqual(200);
            expect(res.headers.get("content-type")).toEqual("text/event-stream");
            res.text().then(function (body) {
              expect(body).toContain("candidates");
              expect(body).toContain("finishReason");
              done();
            });
          });
        });
      });
    });
  });
});
