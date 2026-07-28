import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Upstage API Proxy", function () {
  var port = 9380;
  var upstagePort = 9390;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var upstageServer;

  afterEach(function (callback) {
    if (upstageServer) {
      upstageServer.close();
      upstageServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockUpstageApi() {
    return new Promise(function (resolve) {
      upstageServer = http.createServer(function (req, res) {
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
              authorization: req.headers["authorization"],
            })
          );
          res.end();
        });
      });
      upstageServer.listen(upstagePort, "127.0.0.1", function () {
        resolve(upstageServer);
      });
    });
  }

  function setupUpstageProxy(extraOptions) {
    var options = Object.assign(
      {
        upstageProxyPath: "/upstage",
        upstageApiUrl: "http://127.0.0.1:" + upstagePort,
        upstageApiKey: "real-upstage-key",
      },
      extraOptions || {}
    );
    return util.setupProxy(listenOptions, options, []);
  }

  // Register a user route so requests from 127.0.0.1 are recognized as
  // coming from a singleuser pod. In production, KubeSpawner registers
  // routes like /user/alice -> http://<pod-ip>:8888.
  function registerUserRoute(proxy) {
    return proxy.addRoute("/user/testuser", {
      target: "http://127.0.0.1:" + (port + 2),
    });
  }

  it("disabled when upstageProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/upstage/v1/chat/completions", {
        method: "POST",
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs", function (done) {
    // No user route registered -> 127.0.0.1 is not a known pod
    setupUpstageProxy().then(function () {
      fetch(proxyUrl + "/upstage/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer dummy" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        done();
      });
    });
  });

  it("proxies request from registered pod IP with Bearer key injection", function (done) {
    startMockUpstageApi().then(function () {
      setupUpstageProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/upstage/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: "Bearer dummy",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "solar-open-2", messages: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.authorization).toEqual("Bearer real-upstage-key");
              expect(body.url).toEqual("/v1/chat/completions");
              done();
            });
        });
      });
    });
  });

  it("strips upstage proxy path prefix from URL", function (done) {
    startMockUpstageApi().then(function () {
      setupUpstageProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/upstage/v1/chat/completions?stream=true", {
            method: "POST",
            headers: { authorization: "Bearer dummy" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual("/v1/chat/completions?stream=true");
              done();
            });
        });
      });
    });
  });

  it("prepends the configured base path to the target", function (done) {
    // When the configured base URL carries a path, it must be prepended
    // to the stripped request URL.
    startMockUpstageApi().then(function () {
      setupUpstageProxy({
        upstageApiUrl: "http://127.0.0.1:" + upstagePort + "/v1",
      }).then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/upstage/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer dummy" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual("/v1/chat/completions");
              done();
            });
        });
      });
    });
  });

  it("does not intercept non-upstage paths", function (done) {
    setupUpstageProxy()
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

  it("returns 500 when UPSTAGE_API_KEY is not configured", function (done) {
    setupUpstageProxy({ upstageApiKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/upstage/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer dummy" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("replaces dummy authorization with prefixed real key (dummy value not forwarded)", function (done) {
    startMockUpstageApi().then(function () {
      setupUpstageProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/upstage/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              // The dummy "Bearer proxy-auth" must NOT reach the Upstage API
              expect(body.authorization).toEqual("Bearer real-upstage-key");
              expect(body.authorization).not.toEqual("Bearer proxy-auth");
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    upstageServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          'data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}\n\n'
        );
        res.write(
          'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    upstageServer.listen(upstagePort, "127.0.0.1", function () {
      setupUpstageProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/upstage/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: "Bearer dummy",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ stream: true }),
          }).then(function (res) {
            expect(res.status).toEqual(200);
            expect(res.headers.get("content-type")).toEqual("text/event-stream");
            res.text().then(function (body) {
              expect(body).toContain("chat.completion.chunk");
              expect(body).toContain("[DONE]");
              done();
            });
          });
        });
      });
    });
  });
});
