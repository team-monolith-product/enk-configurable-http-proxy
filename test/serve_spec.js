import http from "node:http";
import fetch from "node-fetch";
import WebSocket from "ws";
import { WebSocketServer } from "ws";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe("Serve Path Routing", function () {
  var port = 9100;
  var servePort = 9110;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;

  afterEach(function (callback) {
    util.teardownServers(callback);
  });

  function setupServeProxy(extraOptions) {
    var options = Object.assign(
      { servePath: "/serve", servePort: servePort },
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

  it("disabled when servePath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function (proxy) {
      // add a user route so there's something to match
      proxy.addRoute("/user/alice", { target: "http://127.0.0.1:" + servePort }).then(function () {
        fetch(proxyUrl + "/serve/alice/").then(function (res) {
          // should 404 because serve routing is disabled
          expect(res.status).toEqual(404);
          done();
        });
      });
    });
  });

  it("proxies HTTP request to serve port", function (done) {
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
        return fetch(proxyUrl + "/serve/alice/index.html");
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

  it("strips serve prefix from proxied URL", function (done) {
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
        return fetch(proxyUrl + "/serve/bob/path/to/file.js");
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
        return fetch(proxyUrl + "/serve/carol/");
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

  it("proxies WebSocket to serve port", function (done) {
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
        var ws = new WebSocket("ws://127.0.0.1:" + port + "/serve/dave/ws");
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
      fetch(proxyUrl + "/serve/unknown-user/").then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("returns 503 when dev server is not running", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        // add user route, but don't start a serve server on servePort
        return proxy.addRoute("/user/eve", {
          target: "http://127.0.0.1:" + (port + 2),
        });
      })
      .then(function () {
        fetch(proxyUrl + "/serve/eve/").then(function (res) {
          expect(res.status).toEqual(503);
          done();
        });
      });
  });

  it("does not affect normal /user/ routing", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        // add a real target on the user route port
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
        // shift last_activity into the past
        return proxy._routes.update("/user/grace", {
          last_activity: new Date(Date.now() - 60000),
        });
      })
      .then(function () {
        return proxy._routes.get("/user/grace");
      })
      .then(function (routeBefore) {
        var activityBefore = routeBefore.last_activity;
        return fetch(proxyUrl + "/serve/grace/page.html").then(function (res) {
          expect(res.status).toEqual(200);
          // wait briefly for async activity update
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

  // ---- /_next/ asset fallback via Referer ----

  it("routes /_next/ request to correct user via Referer header", function (done) {
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
        return fetch(proxyUrl + "/_next/static/chunks/main.js", {
          headers: { Referer: proxyUrl + "/serve/alice/dashboard" },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(200);
        return res.json();
      })
      .then(function (body) {
        expect(body.served).toBe(true);
        // the full /_next/... path must be forwarded unchanged
        expect(body.url).toEqual("/_next/static/chunks/main.js");
        serveServer.close();
        done();
      });
  });

  it("returns 404 for /_next/ request without Referer", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return proxy.addRoute("/user/alice", {
          target: "http://127.0.0.1:" + (port + 2),
        });
      })
      .then(function () {
        return fetch(proxyUrl + "/_next/static/chunks/main.js");
      })
      .then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
  });

  it("returns 404 for /_next/ request with Referer pointing to unknown user", function (done) {
    setupServeProxy()
      .then(function () {
        return fetch(proxyUrl + "/_next/static/chunks/main.js", {
          headers: { Referer: proxyUrl + "/serve/nobody/page" },
        });
      })
      .then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
  });

  it("does not fallback for non-/_next/ bare paths", function (done) {
    setupServeProxy()
      .then(function (proxy) {
        return startServeServer(servePort).then(function (server) {
          return proxy
            .addRoute("/user/alice", {
              target: "http://127.0.0.1:" + (port + 2),
            })
            .then(function () {
              return server;
            });
        });
      })
      .then(function (serveServer) {
        return fetch(proxyUrl + "/random/path", {
          headers: { Referer: proxyUrl + "/serve/alice/" },
        }).then(function (res) {
          // should NOT be routed to serve target — falls through to normal routing (404)
          expect(res.status).toEqual(404);
          serveServer.close();
          done();
        });
      });
  });
});
