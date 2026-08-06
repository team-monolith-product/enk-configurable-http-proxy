import http from "node:http";
import fetch from "node-fetch";

import { ConfigurableProxy, parseListenOptions } from "../lib/configproxy.js";
import {
  VertexTokenSource,
  createVertexProxy,
  decodeServiceAccountKey,
  defaultVertexApiUrl,
} from "../lib/vertexauth.js";
import * as util from "../lib/testutil.js";

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

var FAKE_CREDENTIALS = {
  type: "service_account",
  project_id: "test-project",
  client_email: "vertex@test-project.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
};

function encodeCredentials(overrides) {
  var credentials = Object.assign({}, FAKE_CREDENTIALS, overrides || {});
  return Buffer.from(JSON.stringify(credentials), "utf8").toString("base64");
}

describe("Vertex service account key decoding", function () {
  it("decodes a base64 encoded service account key", function () {
    var credentials = decodeServiceAccountKey(encodeCredentials());
    expect(credentials.project_id).toEqual("test-project");
  });

  it("rejects a key that is not valid base64 JSON", function () {
    expect(function () {
      decodeServiceAccountKey("bm90LWpzb24=");
    }).toThrowError(/does not decode to valid JSON/);
  });

  it("rejects a credential that is not a service account", function () {
    expect(function () {
      decodeServiceAccountKey(encodeCredentials({ type: "authorized_user" }));
    }).toThrowError(/not a service account key/);
  });

  it("rejects a key missing the private key", function () {
    expect(function () {
      decodeServiceAccountKey(encodeCredentials({ private_key: "" }));
    }).toThrowError(/missing required field private_key/);
  });
});

describe("Vertex token source", function () {
  function sourceReturning(accessToken) {
    var source = new VertexTokenSource(FAKE_CREDENTIALS);
    source._auth = {
      getClient: function () {
        return Promise.resolve({
          getAccessToken: function () {
            return Promise.resolve(accessToken);
          },
        });
      },
    };
    return source;
  }

  it("returns the issued token as a bearer header", async function () {
    expect(await sourceReturning({ token: "abc123" }).authorizationHeader()).toEqual(
      "Bearer abc123"
    );
  });

  it("throws when the token endpoint returns no token", async function () {
    await expectAsync(sourceReturning({ token: null }).authorizationHeader()).toBeRejectedWithError(
      /empty token/
    );
  });
});

describe("Vertex default API URL", function () {
  it("uses the global endpoint for the global location", function () {
    expect(defaultVertexApiUrl("proj", "global")).toEqual(
      "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi"
    );
  });

  it("uses the regional endpoint for a regional location", function () {
    expect(defaultVertexApiUrl("proj", "us-central1")).toEqual(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/endpoints/openapi"
    );
  });
});

describe("Vertex proxy entry", function () {
  var log = { error: function () {} };

  it("is disabled when no proxy path is configured", function () {
    expect(createVertexProxy({}, log)).toBeNull();
  });

  it("derives the API URL from the key project and the configured location", function () {
    var entry = createVertexProxy(
      {
        vertexProxyPath: "/vertex",
        vertexLocation: "asia-northeast3",
        vertexServiceAccountKey: encodeCredentials(),
      },
      log
    );
    expect(entry.apiUrl).toEqual(
      "https://asia-northeast3-aiplatform.googleapis.com/v1/projects/test-project/locations/asia-northeast3/endpoints/openapi"
    );
  });

  it("falls back to the global location when none is configured", function () {
    var entry = createVertexProxy(
      { vertexProxyPath: "/vertex", vertexServiceAccountKey: encodeCredentials() },
      log
    );
    expect(entry.apiUrl).toContain("/locations/global/");
  });

  it("leaves the entry without a credential resolver when the key is unusable", function () {
    var entry = createVertexProxy(
      { vertexProxyPath: "/vertex", vertexServiceAccountKey: "bm90LWpzb24=" },
      log
    );
    expect(entry.getAuthValue).toBeUndefined();
  });
});

describe("Vertex API Proxy", function () {
  var port = 9280;
  var vertexPort = 9290;
  var listenOptions = { port: port, ip: "127.0.0.1" };
  var proxyUrl = "http://127.0.0.1:" + port;
  var vertexServer;

  beforeEach(function () {
    // 실제 토큰 발급은 Google 로 나가므로 항상 대역으로 바꾼다.
    spyOn(VertexTokenSource.prototype, "authorizationHeader").and.callFake(function () {
      return Promise.resolve("Bearer issued-access-token");
    });
  });

  afterEach(function (callback) {
    if (vertexServer) {
      vertexServer.close();
      vertexServer = null;
    }
    util.teardownServers(callback);
  });

  function startMockVertexApi() {
    return new Promise(function (resolve) {
      vertexServer = http.createServer(function (req, res) {
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
      vertexServer.listen(vertexPort, "127.0.0.1", function () {
        resolve(vertexServer);
      });
    });
  }

  function setupVertexProxy(extraOptions) {
    var options = Object.assign(
      {
        vertexProxyPath: "/vertex",
        vertexApiUrl: "http://127.0.0.1:" + vertexPort,
        vertexServiceAccountKey: encodeCredentials(),
      },
      extraOptions || {}
    );
    return util.setupProxy(listenOptions, options, []);
  }

  // Register a user route so requests from 127.0.0.1 are recognized as
  // coming from a singleuser pod.
  function registerUserRoute(proxy) {
    return proxy.addRoute("/user/testuser", {
      target: "http://127.0.0.1:" + (port + 2),
    });
  }

  it("disabled when vertexProxyPath is not set", function (done) {
    util.setupProxy(listenOptions, {}, []).then(function () {
      fetch(proxyUrl + "/vertex/chat/completions", { method: "POST" }).then(function (res) {
        expect(res.status).toEqual(404);
        done();
      });
    });
  });

  it("rejects requests from unregistered IPs without issuing a token", function (done) {
    setupVertexProxy().then(function () {
      fetch(proxyUrl + "/vertex/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer proxy-auth" },
      }).then(function (res) {
        expect(res.status).toEqual(403);
        expect(VertexTokenSource.prototype.authorizationHeader).not.toHaveBeenCalled();
        done();
      });
    });
  });

  it("injects the issued access token for a registered pod IP", function (done) {
    startMockVertexApi().then(function () {
      setupVertexProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/vertex/chat/completions", {
            method: "POST",
            headers: {
              authorization: "Bearer proxy-auth",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages: [] }),
          })
            .then(function (res) {
              expect(res.status).toEqual(200);
              return res.json();
            })
            .then(function (body) {
              expect(body.authorization).toEqual("Bearer issued-access-token");
              expect(body.url).toEqual("/chat/completions");
              done();
            });
        });
      });
    });
  });

  it("strips the vertex proxy path prefix from the URL", function (done) {
    startMockVertexApi().then(function () {
      setupVertexProxy().then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/vertex/chat/completions?stream=true", {
            method: "POST",
            headers: { authorization: "Bearer proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual("/chat/completions?stream=true");
              done();
            });
        });
      });
    });
  });

  it("prepends the OpenAI-compatible base path to the target", function (done) {
    startMockVertexApi().then(function () {
      setupVertexProxy({
        vertexApiUrl:
          "http://127.0.0.1:" + vertexPort + "/v1/projects/p/locations/global/endpoints/openapi",
      }).then(function (proxy) {
        registerUserRoute(proxy).then(function () {
          fetch(proxyUrl + "/vertex/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer proxy-auth" },
          })
            .then(function (res) {
              return res.json();
            })
            .then(function (body) {
              expect(body.url).toEqual(
                "/v1/projects/p/locations/global/endpoints/openapi/chat/completions"
              );
              done();
            });
        });
      });
    });
  });

  it("does not intercept non-vertex paths", function (done) {
    setupVertexProxy()
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

  it("returns 500 when VERTEX_SA_KEY is not configured", function (done) {
    setupVertexProxy({ vertexServiceAccountKey: undefined }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/vertex/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer proxy-auth" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("stays up and returns 500 when VERTEX_SA_KEY is malformed", function (done) {
    setupVertexProxy({ vertexServiceAccountKey: "bm90LWpzb24=" }).then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/vertex/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer proxy-auth" },
        }).then(function (res) {
          expect(res.status).toEqual(500);
          done();
        });
      });
    });
  });

  it("returns 502 when access token issuance fails", function (done) {
    VertexTokenSource.prototype.authorizationHeader.and.callFake(function () {
      return Promise.reject(new Error("token endpoint unreachable"));
    });
    setupVertexProxy().then(function (proxy) {
      registerUserRoute(proxy).then(function () {
        fetch(proxyUrl + "/vertex/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer proxy-auth" },
        }).then(function (res) {
          expect(res.status).toEqual(502);
          done();
        });
      });
    });
  });
});
