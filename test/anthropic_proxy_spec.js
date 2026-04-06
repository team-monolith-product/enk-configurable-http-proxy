import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Anthropic API Proxy", function () {
  var port = 9200;
  var anthropicPort = 9210;
  var hubApiPort = 9211;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var anthropicServer;
  var hubApiServer;

  afterEach(function (callback) {
    if (anthropicServer) {
      anthropicServer.close();
      anthropicServer = null;
    }
    if (hubApiServer) {
      hubApiServer.close();
      hubApiServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockAnthropicApi() {
    // Mock Anthropic API that echoes back request details
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
              anthropicVersion: req.headers["anthropic-version"],
              // Confirm the original token is NOT forwarded
              hasOriginalToken: req.headers["x-api-key"] !== "real-anthropic-key",
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

  function startMockHubApi(validTokens) {
    // Mock JupyterHub API that validates tokens
    // validTokens is a map of token -> user info
    return new Promise(function (resolve) {
      hubApiServer = http.createServer(function (req, res) {
        // Expect: GET /hub/api/authorizations/token/<token>
        var match = req.url.match(/\/hub\/api\/authorizations\/token\/(.+)/);
        if (match) {
          var token = decodeURIComponent(match[1]);
          var user = validTokens[token];
          if (user) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write(JSON.stringify(user));
            res.end();
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });
      hubApiServer.listen(hubApiPort, "127.0.0.1", function () {
        resolve(hubApiServer);
      });
    });
  }

  function setupAnthropicProxy(extraOptions) {
    var options = Object.assign(
      {
        anthropicProxyPath: "/anthropic",
        anthropicApiUrl: "http://127.0.0.1:" + anthropicPort,
        anthropicApiKey: "real-anthropic-key",
        anthropicHubApiUrl: "http://127.0.0.1:" + hubApiPort + "/hub/api",
      },
      extraOptions || {}
    );
    return util.setupProxy(listenOptions, options, []);
  }

  it("disabled when anthropicProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "some-token" },
      }).then(function (res) {
        // should 404 because anthropic proxy is disabled
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests without x-api-key header", function (done) {
    setupAnthropicProxy().then(function () {
      fetch(proxyUrl + "/anthropic/v1/messages", {
        method: "POST",
      }).then(function (res) {
        expect(res.status).toEqual(401);
        done();
      });
    });
  });

  it("rejects requests with invalid token", function (done) {
    startMockHubApi({ "valid-token": { name: "alice" } }).then(function () {
      setupAnthropicProxy().then(function () {
        fetch(proxyUrl + "/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": "invalid-token" },
        }).then(function (res) {
          expect(res.status).toEqual(403);
          done();
        });
      });
    });
  });

  it("proxies authenticated request with key injection", function (done) {
    Promise.all([
      startMockAnthropicApi(),
      startMockHubApi({ "user-hub-token": { name: "alice" } }),
    ]).then(function () {
      setupAnthropicProxy().then(function () {
        fetch(proxyUrl + "/anthropic/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": "user-hub-token",
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
            // The mock Anthropic API should receive the real key, not the user's token
            expect(body.apiKey).toEqual("real-anthropic-key");
            // URL should be stripped of the /anthropic prefix
            expect(body.url).toEqual("/v1/messages");
            done();
          });
      });
    });
  });

  it("strips anthropic proxy path prefix from URL", function (done) {
    Promise.all([
      startMockAnthropicApi(),
      startMockHubApi({ "user-token": { name: "bob" } }),
    ]).then(function () {
      setupAnthropicProxy().then(function () {
        fetch(proxyUrl + "/anthropic/v1/messages?stream=true", {
          method: "POST",
          headers: { "x-api-key": "user-token" },
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

  it("does not intercept non-anthropic paths", function (done) {
    startMockHubApi({}).then(function () {
      setupAnthropicProxy()
        .then(function (proxy) {
          return util.addTarget(proxy, "/", port + 2, false);
        })
        .then(function () {
          return fetch(proxyUrl + "/user/alice/test");
        })
        .then(function (res) {
          // Should fall through to normal routing
          expect(res.status).not.toEqual(401);
          done();
        });
    });
  });

  it("returns 500 when ANTHROPIC_API_KEY is not configured", function (done) {
    startMockHubApi({ "user-token": { name: "alice" } }).then(function () {
      setupAnthropicProxy({ anthropicApiKey: undefined }).then(function () {
        fetch(proxyUrl + "/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": "user-token" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("caches validated tokens", function (done) {
    var hubRequestCount = 0;
    // Custom hub server that counts requests
    hubApiServer = http.createServer(function (req, res) {
      hubRequestCount++;
      var match = req.url.match(/\/hub\/api\/authorizations\/token\/(.+)/);
      if (match && match[1] === "cached-token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(JSON.stringify({ name: "carol" }));
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    hubApiServer.listen(hubApiPort, "127.0.0.1", function () {
      startMockAnthropicApi().then(function () {
        setupAnthropicProxy({
          anthropicHubApiUrl: "http://127.0.0.1:" + hubApiPort + "/hub/api",
        }).then(function () {
          // First request
          fetch(proxyUrl + "/anthropic/v1/messages", {
            method: "POST",
            headers: { "x-api-key": "cached-token" },
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              // Second request should use cache
              return fetch(proxyUrl + "/anthropic/v1/messages", {
                method: "POST",
                headers: { "x-api-key": "cached-token" },
              });
            })
            .then(function (res) {
              expect(res.status).toEqual(200);
              // Hub API should have been called only once
              expect(hubRequestCount).toEqual(1);
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    // Replace mock anthropic server with one that streams SSE
    if (anthropicServer) {
      anthropicServer.close();
      anthropicServer = null;
    }

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
      startMockHubApi({ "stream-token": { name: "dave" } }).then(function () {
        setupAnthropicProxy().then(function () {
          fetch(proxyUrl + "/anthropic/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": "stream-token",
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
