import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("OpenAI API Proxy", function () {
  var port = 9300;
  var openaiPort = 9310;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var openaiServer;

  afterEach(function (callback) {
    if (openaiServer) {
      openaiServer.close();
      openaiServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockOpenaiApi() {
    return new Promise(function (resolve) {
      openaiServer = http.createServer(function (req, res) {
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
      openaiServer.listen(openaiPort, "127.0.0.1", function () {
        resolve(openaiServer);
      });
    });
  }

  function setupOpenaiProxy(extraOptions) {
    var options = Object.assign(
      {
        openaiProxyPath: "/openai",
        openaiApiUrl: "http://127.0.0.1:" + openaiPort,
        openaiApiKey: "real-openai-key",
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

  it("disabled when openaiProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/openai/v1/responses", {
        method: "POST",
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs", function (done) {
    // No user route registered -> 127.0.0.1 is not a known pod
    setupOpenaiProxy().then(function () {
      fetch(proxyUrl + "/openai/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer proxy-auth" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        done();
      });
    });
  });

  it("proxies request from registered pod IP with a Bearer-prefixed key", function (done) {
    startMockOpenaiApi().then(function () {
      setupOpenaiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/openai/v1/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer proxy-auth",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-5.6-luna", input: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.authorization).toEqual("Bearer real-openai-key");
              expect(body.url).toEqual("/v1/responses");
              done();
            });
        });
      });
    });
  });

  it("strips openai proxy path prefix from URL", function (done) {
    startMockOpenaiApi().then(function () {
      setupOpenaiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/openai/v1/responses?stream=true", {
            method: "POST",
            headers: { authorization: "Bearer proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual("/v1/responses?stream=true");
              done();
            });
        });
      });
    });
  });

  it("does not intercept non-openai paths", function (done) {
    setupOpenaiProxy()
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

  it("returns 500 when OPENAI_API_KEY is not configured", function (done) {
    setupOpenaiProxy({ openaiApiKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/openai/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer proxy-auth" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("replaces the dummy Authorization header with the real key", function (done) {
    startMockOpenaiApi().then(function () {
      setupOpenaiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/openai/v1/responses", {
            method: "POST",
            headers: { authorization: "Bearer proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              // The dummy "proxy-auth" must NOT reach the OpenAI API
              expect(body.authorization).toEqual("Bearer real-openai-key");
              expect(body.authorization).not.toContain("proxy-auth");
              done();
            });
        });
      });
    });
  });

  it("handles SSE streaming responses", function (done) {
    openaiServer = http.createServer(function (req, res) {
      req.on("data", function () {});
      req.on("end", function () {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: response.created\ndata: {\"type\":\"response.created\"}\n\n");
        res.write("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n");
        res.end();
      });
    });

    openaiServer.listen(openaiPort, "127.0.0.1", function () {
      setupOpenaiProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/openai/v1/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer proxy-auth",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ stream: true }),
          }).then(function (res) {
            expect(res.status).toEqual(200);
            expect(res.headers.get("content-type")).toEqual("text/event-stream");
            res.text().then(function (body) {
              expect(body).toContain("response.created");
              expect(body).toContain("response.completed");
              done();
            });
          });
        });
      });
    });
  });
});
