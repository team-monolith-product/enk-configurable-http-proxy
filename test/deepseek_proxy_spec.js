import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("DeepSeek API Proxy", function () {
  var port = 9240;
  var deepseekPort = 9250;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var deepseekServer;

  afterEach(function (callback) {
    if (deepseekServer) {
      deepseekServer.close();
      deepseekServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockDeepseekApi() {
    return new Promise(function (resolve) {
      deepseekServer = http.createServer(function (req, res) {
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
            })
          );
          res.end();
        });
      });
      deepseekServer.listen(deepseekPort, "127.0.0.1", function () {
        resolve(deepseekServer);
      });
    });
  }

  function setupDeepseekProxy(extraOptions) {
    var options = Object.assign(
      {
        deepseekProxyPath: "/deepseek",
        deepseekApiUrl: "http://127.0.0.1:" + deepseekPort,
        deepseekApiKey: "real-deepseek-key",
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

  it("disabled when deepseekProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/deepseek/v1/messages", {
        method: "POST",
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs", function (done) {
    // No user route registered -> 127.0.0.1 is not a known pod
    setupDeepseekProxy().then(function () {
      fetch(proxyUrl + "/deepseek/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "dummy" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        done();
      });
    });
  });

  it("proxies request from registered pod IP with key injection", function (done) {
    startMockDeepseekApi().then(function () {
      setupDeepseekProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/deepseek/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": "dummy",
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "deepseek-v4-pro", messages: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.apiKey).toEqual("real-deepseek-key");
              expect(body.url).toEqual("/v1/messages");
              done();
            });
        });
      });
    });
  });

  it("strips deepseek proxy path prefix from URL", function (done) {
    startMockDeepseekApi().then(function () {
      setupDeepseekProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/deepseek/v1/messages?stream=true", {
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
    // DeepSeek's Anthropic endpoint lives under /anthropic, so the configured
    // base path must be prepended to the stripped request URL.
    startMockDeepseekApi().then(function () {
      setupDeepseekProxy({
        deepseekApiUrl: "http://127.0.0.1:" + deepseekPort + "/anthropic",
      }).then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/deepseek/v1/messages", {
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

  it("does not intercept non-deepseek paths", function (done) {
    setupDeepseekProxy()
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

  it("returns 500 when DEEPSEEK_API_KEY is not configured", function (done) {
    setupDeepseekProxy({ deepseekApiKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/deepseek/v1/messages", {
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
    startMockDeepseekApi().then(function () {
      setupDeepseekProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/deepseek/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              // The dummy "proxy-auth" must NOT reach the DeepSeek API
              expect(body.apiKey).toEqual("real-deepseek-key");
              expect(body.apiKey).not.toEqual("proxy-auth");
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    deepseekServer = http.createServer(function (req, res) {
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

    deepseekServer.listen(deepseekPort, "127.0.0.1", function () {
      setupDeepseekProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/deepseek/v1/messages", {
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
