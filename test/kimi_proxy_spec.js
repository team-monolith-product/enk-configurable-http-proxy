import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Kimi API Proxy", function () {
  var port = 9280;
  var kimiPort = 9290;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var kimiServer;

  afterEach(function (callback) {
    if (kimiServer) {
      kimiServer.close();
      kimiServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockKimiApi() {
    return new Promise(function (resolve) {
      kimiServer = http.createServer(function (req, res) {
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
              apiKey: req.headers["x-api-key"],
              headers: req.headers,
            })
          );
          res.end();
        });
      });
      kimiServer.listen(kimiPort, "127.0.0.1", function () {
        resolve(kimiServer);
      });
    });
  }

  function setupKimiProxy(extraOptions) {
    var options = Object.assign(
      {
        kimiProxyPath: "/kimi",
        kimiApiUrl: "http://127.0.0.1:" + kimiPort,
        kimiApiKey: "real-kimi-key",
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

  it("disabled when kimiProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/kimi/v1/messages", {
        method: "POST",
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs", function (done) {
    // No user route registered -> 127.0.0.1 is not a known pod
    setupKimiProxy().then(function () {
      fetch(proxyUrl + "/kimi/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "dummy" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        done();
      });
    });
  });

  it("proxies request from registered pod IP with key injection", function (done) {
    startMockKimiApi().then(function () {
      setupKimiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/kimi/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": "dummy",
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "kimi-k2", messages: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.apiKey).toEqual("real-kimi-key");
              expect(body.url).toEqual("/v1/messages");
              done();
            });
        });
      });
    });
  });

  it("does not forward x-forwarded-* headers to the upstream API", function (done) {
    // Moonshot 은 빈 x-forwarded-host 를 Host 로 채택해 400 을 반환하므로 x-forwarded-* 를 보내면 안 된다.
    startMockKimiApi().then(function () {
      setupKimiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/kimi/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "dummy", "x-forwarded-host": "proxy-public" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              var forwarded = Object.keys(body.headers).filter(function (name) {
                return name.startsWith("x-forwarded-");
              });
              expect(forwarded).toEqual([]);
              expect(body.headers["host"]).toEqual("127.0.0.1:" + kimiPort);
              done();
            });
        });
      });
    });
  });

  it("strips kimi proxy path prefix from URL", function (done) {
    startMockKimiApi().then(function () {
      setupKimiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/kimi/v1/messages?stream=true", {
            method: "POST",
            headers: { "x-api-key": "dummy" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual("/v1/messages?stream=true");
              done();
            });
        });
      });
    });
  });

  it("prepends the Anthropic-compatible base path to the target", function (done) {
    // Kimi's Anthropic endpoint lives under /anthropic, so the configured
    // base path must be prepended to the stripped request URL.
    startMockKimiApi().then(function () {
      setupKimiProxy({
        kimiApiUrl: "http://127.0.0.1:" + kimiPort + "/anthropic",
      }).then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/kimi/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "dummy" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual("/anthropic/v1/messages");
              done();
            });
        });
      });
    });
  });

  it("does not intercept non-kimi paths", function (done) {
    setupKimiProxy()
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

  it("returns 500 when KIMI_API_KEY is not configured", function (done) {
    setupKimiProxy({ kimiApiKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/kimi/v1/messages", {
          method: "POST",
          headers: { "x-api-key": "dummy" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("replaces dummy apiKey with real key (dummy value not forwarded)", function (done) {
    startMockKimiApi().then(function () {
      setupKimiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/kimi/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              // The dummy "proxy-auth" must NOT reach the Kimi API
              expect(body.apiKey).toEqual("real-kimi-key");
              expect(body.apiKey).not.toEqual("proxy-auth");
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    kimiServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
        res.write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n");
        res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        res.end();
      });
    });

    kimiServer.listen(kimiPort, "127.0.0.1", function () {
      setupKimiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/kimi/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": "dummy",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ stream: true }),
          }).then(function (res) {
            expect(res.status).toEqual(200);
            expect(res.headers.get("content-type")).toEqual("text/event-stream");
            res.text().then(function (body) {
              expect(body).toContain("message_start");
              expect(body).toContain("message_stop");
              done();
            });
          });
        });
      });
    });
  });
});
