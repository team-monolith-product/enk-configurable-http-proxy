import http from "node:http";
import fetch from "node-fetch";
import WebSocket from "ws";
import { WebSocketServer } from "ws";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Serve Domain Routing", function () {
  var port = 9100;
  var servePort = 9110;
  var serveDomain = "example.com";
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;

  afterEach(function (callback) {
    util.teardownServers(callback);
  });

  function setupServeProxy(extraOptions) {
    var options = Object.assign(
      { serveDomain: serveDomain, servePort: servePort },
      extraOptions || {}
    );
    return util.setupProxy(listenOptions, options, []);
  }

  function startServeServer(serveServerPort, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var server = http.createServer(function (req, res) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(JSON.stringify({ url: req.url, served: true }));
        res.end();
      });
      if (opts.websocket) {
        var wss = new WebSocketServer({ server: server });
        wss.on("connection", function (ws) {
          ws.on("message", function (message) {
            ws.send(JSON.stringify({ message: message.toString(), served: true }));
          });
          ws.send("serve-connected");
        });
      }
      server.listen(serveServerPort, "127.0.0.1", function () {
        resolve(server);
      });
    });
  }

  it("disabled when serveDomain is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function (proxy) {
      proxy.addRoute("/user/alice", { target: "http://127.0.0.1:" + servePort }).then(function () {
        fetch(proxyUrl + "/", { headers: { Host: "alice.example.com" } }).then(function (res) {
          expect(res.status).toEqual(404);
          done();
        });
      });
    });
  });

  it("proxies HTTP request via subdomain", function (done) {
    var serveServer;
    setupServeProxy()
      .then(function (proxy) {
        return startServeServer(servePort).then(function (server) {
          serveServer = server;
          return proxy.addRoute("/user/alice", {
            target: "http://127.0.0.1:" + (port + 2),
          });
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/index.html", {
          headers: { Host: "alice." + serveDomain },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(200);
        return res.json();
      })
      .then(function (body) {
        expect(body.served).toBe(true);
        expect(body.url).toEqual("/index.html");
        serveServer.close();
        done();
      });
  });

  it("preserves full path for subdomain requests", function (done) {
    var serveServer;
    setupServeProxy()
      .then(function (proxy) {
        return startServeServer(servePort).then(function (server) {
          serveServer = server;
          return proxy.addRoute("/user/bob", {
            target: "http://127.0.0.1:" + (port + 2),
          });
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/path/to/file.js", {
          headers: { Host: "bob." + serveDomain },
        });
      })
      .then(function (res) {
        return res.json();
      })
      .then(function (body) {
        expect(body.url).toEqual("/path/to/file.js");
        serveServer.close();
        done();
      });
  });

  it("handles root path correctly", function (done) {
    var serveServer;
    setupServeProxy()
      .then(function (proxy) {
        return startServeServer(servePort).then(function (server) {
          serveServer = server;
          return proxy.addRoute("/user/carol", {
            target: "http://127.0.0.1:" + (port + 2),
          });
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/", {
          headers: { Host: "carol." + serveDomain },
        });
      })
      .then(function (res) {
        return res.json();
      })
      .then(function (body) {
        expect(body.url).toEqual("/");
        serveServer.close();
        done();
      });
  });

  it("proxies WebSocket via subdomain", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return startServeServer(servePort, { websocket: true }).then(function (server) {
          return proxy
            .addRoute("/user/dave", {
              target: "http://127.0.0.1:" + (port + 2),
            })
            .then(function () {
              return server;
            });
        });
      })
      .then(function (serveServer) {
        var ws = new WebSocket("ws://127.0.0.1:" + port + "/ws", {
          headers: { Host: "dave." + serveDomain },
        });
        ws.on("error", function () {
          expect("error").toEqual("ok");
          serveServer.close();
          done();
        });
        var nmsgs = 0;
        ws.on("message", function (msg) {
          msg = msg.toString();
          if (nmsgs === 0) {
            expect(msg).toEqual("serve-connected");
            ws.send("hello");
          } else {
            var data = JSON.parse(msg);
            expect(data.served).toBe(true);
            expect(data.message).toEqual("hello");
            ws.close();
            serveServer.close();
            done();
          }
          nmsgs++;
        });
      });
  });

  it("returns 404 for unknown user", function (done) {
    setupServeProxy().then(function () {
      fetch(proxyUrl + "/", {
        headers: { Host: "unknown-user." + serveDomain },
      }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("returns 503 when dev server is not running", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return proxy.addRoute("/user/eve", {
          target: "http://127.0.0.1:" + (port + 2),
        });
      })
      .then(function () {
        fetch(proxyUrl + "/", {
          headers: { Host: "eve." + serveDomain },
        }).then(function (res) {
          expect(res.status).toEqual(503);
          done();
        });
      });
  });

  it("does not affect normal /user/ routing", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return util.addTarget(proxy, "/user/frank", port + 2, false);
      })
      .then(function () {
        return fetch(proxyUrl + "/user/frank/test");
      })
      .then(function (res) {
        expect(res.status).toEqual(200);
        return res.json();
      })
      .then(function (body) {
        expect(body.path).toEqual("/user/frank");
        expect(body.url).toEqual("/user/frank/test");
        done();
      });
  });

  it("ignores subdomain with dots (nested subdomain)", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return proxy.addRoute("/user/alice", {
          target: "http://127.0.0.1:" + servePort,
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/", {
          headers: { Host: "sub.alice." + serveDomain },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
  });

  it("responds to CORS preflight", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return proxy.addRoute("/user/alice", {
          target: "http://127.0.0.1:" + (port + 2),
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/", {
          method: "OPTIONS",
          headers: {
            Host: "alice." + serveDomain,
            "Access-Control-Request-Method": "GET",
          },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(204);
        expect(res.headers.get("access-control-allow-origin")).toEqual("*");
        expect(res.headers.get("access-control-allow-methods")).toContain("GET");
        done();
      });
  });

  it("falls through CORS preflight when subdomain has no user route", function (done) {
    setupServeProxy()
      .then(function () {
        return fetch(proxyUrl + "/", {
          method: "OPTIONS",
          headers: {
            Host: "alice." + serveDomain,
            "Access-Control-Request-Method": "GET",
          },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
  });

  it("adds CORS header to proxied response", function (done) {
    var serveServer;
    setupServeProxy()
      .then(function (proxy) {
        return startServeServer(servePort).then(function (server) {
          serveServer = server;
          return proxy.addRoute("/user/alice", {
            target: "http://127.0.0.1:" + (port + 2),
          });
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/index.html", {
          headers: { Host: "alice." + serveDomain },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(200);
        expect(res.headers.get("access-control-allow-origin")).toEqual("*");
        serveServer.close();
        done();
      });
  });

  it("uses custom serve port", function (done) {
    var customPort = 9120;
    var serveServer;
    util
      .setupProxy(listenOptions, { serveDomain: serveDomain, servePort: customPort }, [])
      .then(function (proxy) {
        return startServeServer(customPort).then(function (server) {
          serveServer = server;
          return proxy.addRoute("/user/alice", {
            target: "http://127.0.0.1:" + (port + 2),
          });
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/", {
          headers: { Host: "alice." + serveDomain },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(200);
        return res.json();
      })
      .then(function (body) {
        expect(body.served).toBe(true);
        serveServer.close();
        done();
      });
  });

  it("updates last_activity on the user route", function (done) {
    var serveServer;
    var proxy;
    setupServeProxy()
      .then(function (p) {
        proxy = p;
        return startServeServer(servePort).then(function (server) {
          serveServer = server;
          return proxy.addRoute("/user/grace", {
            target: "http://127.0.0.1:" + (port + 2),
          });
        });
      })
      .then(function () {
        return proxy._routes.update("/user/grace", {
          last_activity: new Date(Date.now() - 60000),
        });
      })
      .then(function () {
        return proxy._routes.get("/user/grace");
      })
      .then(function (routeBefore) {
        var activityBefore = routeBefore.last_activity;
        return fetch(proxyUrl + "/page.html", {
          headers: { Host: "grace." + serveDomain },
        }).then(function (res) {
          expect(res.status).toEqual(200);
          return new Promise(function (resolve) {
            setTimeout(resolve, 200);
          }).then(function () {
            return proxy._routes.get("/user/grace").then(function (routeAfter) {
              expect(routeAfter.last_activity).toBeGreaterThan(activityBefore);
              serveServer.close();
              done();
            });
          });
        });
      });
  });
});
