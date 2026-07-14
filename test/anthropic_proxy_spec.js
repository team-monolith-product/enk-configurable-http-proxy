import http from "node:http";
import zlib from "node:zlib";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import { sentry } from "../lib/sentry.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Anthropic API Proxy", function () {
  var port = 9200;
  var anthropicPort = 9210;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var anthropicServer;

  afterEach(function (callback) {
    if (anthropicServer) {
      anthropicServer.close();
      anthropicServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockAnthropicApi() {
    return new Promise(function (resolve) {
      anthropicServer = http.createServer(function (req, res) {
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
      anthropicServer.listen(anthropicPort, "127.0.0.1", function () {
        resolve(anthropicServer);
      });
    });
  }

  function setupAnthropicProxy(extraOptions) {
    var options = Object.assign(
      {
        anthropicProxyPath: "/anthropic",
        anthropicApiUrl: "http://127.0.0.1:" + anthropicPort,
        anthropicApiKey: "real-anthropic-key",
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

  it("disabled when anthropicProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/anthropic/v1/messages", {
        method: "POST",
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs", function (done) {
    // No user route registered -> 127.0.0.1 is not a known pod
    setupAnthropicProxy().then(function () {
      fetch(proxyUrl + "/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "dummy" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        done();
      });
    });
  });

  it("proxies request from registered pod IP with key injection", function (done) {
    startMockAnthropicApi().then(function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": "dummy",
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.apiKey).toEqual("real-anthropic-key");
              expect(body.url).toEqual("/v1/messages");
              done();
            });
        });
      });
    });
  });

  it("strips anthropic proxy path prefix from URL", function (done) {
    startMockAnthropicApi().then(function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages?stream=true", {
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

  it("does not intercept non-anthropic paths", function (done) {
    setupAnthropicProxy()
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

  it("returns 500 when ANTHROPIC_API_KEY is not configured", function (done) {
    setupAnthropicProxy({ anthropicApiKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/anthropic/v1/messages", {
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
    startMockAnthropicApi().then(function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              // The dummy "proxy-auth" must NOT reach the Anthropic API
              expect(body.apiKey).toEqual("real-anthropic-key");
              expect(body.apiKey).not.toEqual("proxy-auth");
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    anthropicServer = http.createServer(function (req, res) {
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

    anthropicServer.listen(anthropicPort, "127.0.0.1", function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages", {
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

  it("captures upstream 5xx responses to sentry", function (done) {
    spyOn(sentry, "captureApiProxyResponse");
    anthropicServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(529, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }));
      });
    });

    anthropicServer.listen(anthropicPort, "127.0.0.1", function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages?stream=true", {
            method: "POST",
            headers: { "x-api-key": "dummy" },
          })
            .then(function (res) {
              expect(res.status).toEqual(529);
              return res.json();
            })
            .then(function (body) {
              expect(body.error.type).toEqual("overloaded_error");
              expect(sentry.captureApiProxyResponse).toHaveBeenCalledWith(
                "Anthropic",
                529,
                "POST",
                "/v1/messages",
                jasmine.stringContaining("overloaded_error")
              );
              done();
            });
        });
      });
    });
  });

  it("captures gzip-compressed upstream 5xx bodies to sentry", function (done) {
    spyOn(sentry, "captureApiProxyResponse");
    var gzipped = zlib.gzipSync(JSON.stringify({ type: "error", error: { type: "api_error" } }));
    anthropicServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(500, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
        res.end(gzipped);
      });
    });

    anthropicServer.listen(anthropicPort, "127.0.0.1", function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "dummy" },
          })
            .then(function (res) {
              expect(res.status).toEqual(500);
              return res.json();
            })
            .then(function (body) {
              expect(body.error.type).toEqual("api_error");
              expect(sentry.captureApiProxyResponse).toHaveBeenCalledWith(
                "Anthropic",
                500,
                "POST",
                "/v1/messages",
                jasmine.stringContaining("api_error")
              );
              done();
            });
        });
      });
    });
  });

  it("captures upstream 4xx responses to sentry", function (done) {
    spyOn(sentry, "captureApiProxyResponse");
    anthropicServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
      });
    });

    anthropicServer.listen(anthropicPort, "127.0.0.1", function () {
      setupAnthropicProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "dummy" },
          })
            .then(function (res) {
              expect(res.status).toEqual(429);
              return res.json();
            })
            .then(function (body) {
              expect(body.error.type).toEqual("rate_limit_error");
              expect(sentry.captureApiProxyResponse).toHaveBeenCalledWith(
                "Anthropic",
                429,
                "POST",
                "/v1/messages",
                jasmine.stringContaining("rate_limit_error")
              );
              done();
            });
        });
      });
    });
  });

  it("captures upstream connection failures to sentry", function (done) {
    spyOn(sentry, "captureApiProxyError");
    setupAnthropicProxy().then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": "dummy" },
        }).then(function (res) {
          expect(res.status).toEqual(502);
          expect(sentry.captureApiProxyError).toHaveBeenCalledWith(
            "Anthropic",
            jasmine.any(Error),
            "POST",
            "/v1/messages"
          );
          done();
        });
      });
    });
  });
});
