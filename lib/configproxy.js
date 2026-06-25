// A Configurable node-http-proxy
//
// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// POST, DELETE to /api/routes[:/path/to/proxy] to update the routing table
// GET /api/routes to see the current routing table
//

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { default as httpProxy } from "http-proxy-3";

import { defaultLogger } from "./log.js";
import * as metrics from "./metrics.js";
import { trimPrefix } from "./trie.js";
import { ValkeyStore } from "./store.js";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseListenOptions(args, logger) {
  var listen = {};

  if (args.socket) {
    listen.proxyTarget = [args.socket];
  } else {
    listen.port = parseInt(args.port) || 8000;
    if (args.ip === "*") {
      // handle ip=* alias for all interfaces
      logger.warn(
        "Interpreting ip='*' as all-interfaces. Preferred usage is 0.0.0.0 for all IPv4 or '' for all-interfaces."
      );
      args.ip = "";
    }
    listen.ip = args.ip;
    listen.proxyTarget = [listen.port, listen.ip];
  }

  if (args.apiSocket) {
    listen.apiTarget = [args.apiSocket];
  } else {
    listen.apiPort = args.apiPort ? parseInt(args.apiPort) : listen.port ? listen.port + 1 : 8001;
    listen.apiTarget = [listen.apiPort, args.apiIp];
  }

  if (args.metricsSocket) {
    listen.metricsTarget = [args.metricsSocket];
  } else if (args.metricsPort) {
    listen.metricsTarget = [parseInt(args.metricsPort), args.metricsIp];
  }
  return listen;
}

function bound(that, method) {
  // bind a method, to ensure `this=that` when it is called
  // because prototype languages are bad
  return function () {
    return method.apply(that, arguments);
  };
}

function argumentsArray(args) {
  // cast arguments object to array, because Javascript.
  return Array.prototype.slice.call(args, 0);
}

function fail(req, res, code, msg) {
  // log a failure, and finish the HTTP request with an error code
  msg = msg || "";
  res._logMsg = msg;

  if (res.writableEnded) return; // response already done
  if (res.writeHead) res.writeHead(code);
  if (res.write) {
    if (!msg) {
      msg = http.STATUS_CODES[code];
    }
    res.write(msg);
  }
  if (res.end) res.end();
}

function jsonHandler(handler) {
  // wrap json handler, so the handler is called with parsed data,
  // rather than implementing streaming parsing in the handler itself
  return function (req, res) {
    var args = argumentsArray(arguments);
    var buf = "";
    req.on("data", function (chunk) {
      buf += chunk;
    });
    req.on("end", function () {
      var data;
      try {
        data = JSON.parse(buf) || {};
      } catch (e) {
        fail(req, res, 400, "Body not valid JSON: " + e);
        return;
      }
      args.push(data);
      handler.apply(handler, args);
    });
  };
}

function authorized(method) {
  // decorator for token-authorized handlers
  return function (req, res) {
    if (!this.authToken) {
      return method.apply(this, arguments);
    }
    var match = (req.headers.authorization || "").match(/token\s+(\S+)/);
    var token;
    if (match !== null) {
      token = match[1];
    }
    if (token === this.authToken) {
      return method.apply(this, arguments);
    } else {
      this.log.debug(
        "Rejecting API request from: %s",
        req.headers.authorization || "no authorization"
      );
      res.writeHead(403);
      res.end();
    }
  };
}

function parseHost(req) {
  var host = req.headers.host;
  if (host) {
    host = host.split(":")[0];
  }
  return host;
}

function camelCaseify(options) {
  // camelCaseify options dict, for backward compatibility
  let camelOptions = {};
  Object.keys(options).forEach((key) => {
    const camelKey = key.replace(/_(.)/g, function (match, part, offset, string) {
      return part.toUpperCase();
    });
    if (camelKey !== key) {
      this.log.warn("option %s is deprecated, use %s.", key, camelKey);
    }
    camelOptions[camelKey] = options[key];
  });
  return camelOptions;
}

const loadStorage = (options) => {
  if (options.storageBackend) {
    const BackendStorageClass = require(options.storageBackend);
    return new BackendStorageClass(options);
  }
  return new ValkeyStore(options);
};

function _logUrl(url) {
  // format a url for logging, e.g. strip url params
  if (url) return url.split("?", 1)[0];
}

export class ConfigurableProxy extends EventEmitter {
  constructor(options) {
    super();
    var that = this;
    this.log = (options || {}).log;
    if (!this.log) {
      this.log = defaultLogger();
    }
    this.options = camelCaseify.apply(this, [options || {}]);

    this._routes = loadStorage(options || {});
    this.authToken = this.options.authToken;
    if (options.includePrefix !== undefined) {
      this.includePrefix = options.includePrefix;
    } else {
      this.includePrefix = true;
    }
    this.headers = this.options.headers;
    this.hostRouting = this.options.hostRouting;
    this.errorTarget = options.errorTarget;
    if (this.errorTarget && this.errorTarget.slice(-1) !== "/") {
      this.errorTarget = this.errorTarget + "/"; // ensure trailing /
    }
    this.errorPath = options.errorPath || path.join(__dirname, "error");
    this.serveDomain = options.serveDomain || null;
    this.servePort = options.servePort || 3000;

    // 외부 LLM API 프록시 설정. 등록된 singleuser pod IP 에서 온 요청에만 실키를 주입해
    // provider 로 포워딩한다(singleuser 에는 키가 없고 네트워크 기반 인증만 쓴다). provider
    // 추가는 이 배열에 한 줄 추가하면 되고, proxyPath 가 없으면 비활성으로 걸러진다.
    // DeepSeek 는 Anthropic 호환 엔드포인트(.../anthropic)라 anthropic 과 같은 x-api-key 를 쓴다.
    this.apiProxies = [
      {
        name: "Anthropic",
        proxyPath: options.anthropicProxyPath ? trimPrefix(options.anthropicProxyPath) : null,
        apiUrl: options.anthropicApiUrl || "https://api.anthropic.com",
        apiKey: options.anthropicApiKey,
        header: "x-api-key",
        envName: "ANTHROPIC_API_KEY",
      },
      {
        name: "Gemini",
        proxyPath: options.geminiProxyPath ? trimPrefix(options.geminiProxyPath) : null,
        apiUrl: options.geminiApiUrl || "https://generativelanguage.googleapis.com",
        apiKey: options.geminiApiKey,
        header: "x-goog-api-key",
        envName: "GEMINI_API_KEY",
      },
      {
        name: "DeepSeek",
        proxyPath: options.deepseekProxyPath ? trimPrefix(options.deepseekProxyPath) : null,
        apiUrl: options.deepseekApiUrl || "https://api.deepseek.com/anthropic",
        apiKey: options.deepseekApiKey,
        header: "x-api-key",
        envName: "DEEPSEEK_API_KEY",
      },
    ].filter((p) => p.proxyPath);

    if (this.options.enableMetrics) {
      this.metrics = new metrics.Metrics();
    } else {
      this.metrics = new metrics.MockMetrics();
    }

    if (this.options.defaultTarget) {
      this.addRoute("/", {
        target: this.options.defaultTarget,
      });
    }
    options.ws = true;
    this.proxy = httpProxy.createProxyServer(options);

    // tornado-style regex routing,
    // because cross-language cargo-culting is always a good idea

    this.apiHandlers = [
      [
        /^\/api\/routes(\/.*)?$/,
        {
          get: bound(this, authorized(this.getRoutes)),
          post: jsonHandler(bound(this, authorized(this.postRoutes))),
          delete: bound(this, authorized(this.deleteRoutes)),
        },
      ],
    ];

    var logErrors = (handler) => {
      return function (req, res) {
        function logError(e) {
          that.log.error("Error in handler for %s %s: %s", req.method, _logUrl(req.url), e);
        }
        try {
          let p = handler.apply(that, arguments);
          if (p) {
            return p.catch(logError);
          }
        } catch (e) {
          logError(e);
        }
      };
    };

    // handle API requests
    var apiCallback = logErrors(that.handleApiRequest);
    if (this.options.apiSsl) {
      this.apiServer = https.createServer(this.options.apiSsl, apiCallback);
    } else {
      this.apiServer = http.createServer(apiCallback);
    }

    // handle metrics
    if (this.options.enableMetrics) {
      var metricsCallback = logErrors(that.handleMetrics);
      this.metricsServer = http.createServer(metricsCallback);
    }

    // need separate agents for http and https requests
    // these agents allow our _upstream_ sockets to be kept alive
    this.httpAgent = http.globalAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = https.globalAgent = new https.Agent({ keepAlive: true });

    // these settings configure requests to the proxy itself to accept keep-alive
    var httpOptions = {
      keepAlive: true,
      keepAliveTimeout: this.options.keepAliveTimeout || 5000,
    };

    // proxy requests separately
    var proxyCallback = logErrors(this.handleProxyWeb);
    if (this.options.ssl) {
      this.proxyServer = https.createServer({ ...this.options.ssl, ...httpOptions }, proxyCallback);
    } else {
      this.proxyServer = http.createServer(httpOptions, proxyCallback);
    }
    // proxy websockets
    this.proxyServer.on("upgrade", bound(this, this.handleProxyWs));

    this.proxy.on("proxyRes", function (proxyRes, req, res) {
      that.metrics.requestsProxyCount.labels(proxyRes.statusCode).inc();
    });
  }

  logResponse(req, res) {
    // log function called when any response is finished
    var code = res.statusCode;
    var logF;
    if (code < 400) {
      logF = this.log.info;
    } else if (code < 500) {
      logF = this.log.warn;
    } else {
      logF = this.log.error;
    }
    var msg = res._logMsg || "";
    logF("%s %s %s %s", code, req.method.toUpperCase(), _logUrl(req.url), msg);
  }

  addRoute(path, data) {
    // add a route to the routing table
    path = this._routes.cleanPath(path);
    if (this.hostRouting && path !== "/") {
      data.host = path.split("/")[1];
    }
    this.log.info("Adding route %s -> %s", path, data.target);

    var that = this;

    return this._routes.add(path, data).then(() => {
      that.updateLastActivity(path);
      that.log.info("Route added %s -> %s", path, data.target);
    });
  }

  removeRoute(path) {
    // remove a route from the routing table
    var routes = this._routes;

    return routes.get(path).then((result) => {
      if (result) {
        this.log.info("Removing route %s", path);
        return routes.remove(path);
      }
    });
  }

  getRoute(req, res, path) {
    // GET a single route
    path = this._routes.cleanPath(path);
    return this._routes.get(path).then(function (route) {
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(JSON.stringify(route));
        res.end();
      }
    });
  }

  getRoutes(req, res, path) {
    // GET /api/routes/(path) gets a single route
    if (path && path.length && path !== "/") {
      return this.getRoute(req, res, path);
    }
    // GET returns routing table as JSON dict
    var that = this;
    var parsed = new URL(req.url, "https://example.com");
    var inactiveSince = null;
    var inactiveSinceParam = parsed.searchParams.get("inactiveSince");
    if (!inactiveSinceParam) {
      // camelCaseify old inactive_since
      inactiveSinceParam = parsed.searchParams.get("inactive_since");
    }
    if (inactiveSinceParam) {
      var timestamp = Date.parse(inactiveSinceParam);
      if (isFinite(timestamp)) {
        inactiveSince = new Date(timestamp);
      } else {
        fail(req, res, 400, "Invalid datestamp '" + inactiveSinceParam + "' must be ISO8601.");
        return;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });

    return this._routes.getAll().then((routes) => {
      var results = {};

      if (inactiveSince) {
        Object.keys(routes).forEach(function (path) {
          if (routes[path].last_activity < inactiveSince) {
            results[path] = routes[path];
          }
        });
      } else {
        results = routes;
      }

      res.write(JSON.stringify(results));
      res.end();
      that.metrics.apiRouteGetCount.inc();
    });
  }

  postRoutes(req, res, path, data) {
    // POST adds a new route
    path = path || "/";

    if (typeof data.target !== "string") {
      this.log.warn("Bad POST data: %s", JSON.stringify(data));
      fail(req, res, 400, "Must specify 'target' as string");
      return;
    }

    var that = this;
    return this.addRoute(path, data).then(function () {
      res.writeHead(201);
      res.end();
      that.metrics.apiRouteAddCount.inc();
    });
  }

  deleteRoutes(req, res, path) {
    // DELETE removes an existing route

    return this._routes.get(path).then((result) => {
      var p, code;
      if (result) {
        p = this.removeRoute(path);
        code = 204;
      } else {
        p = Promise.resolve();
        code = 404;
      }
      return p.then(() => {
        res.writeHead(code);
        res.end();
        this.metrics.apiRouteDeleteCount.inc();
      });
    });
  }

  proxyOptsForTarget(target) {
    var proxyOptions = { target };

    if (target.protocol.startsWith("unix")) {
      // No need for agents for unix sockets
      // No support for https for unix sockets
      proxyOptions.secure = false;
      proxyOptions.target.socketPath = decodeURIComponent(target.host);
    } else if (target.protocol.startsWith("https")) {
      proxyOptions.secure = true;
      proxyOptions.agent = this.httpsAgent;
    } else if (target.protocol.startsWith("http")) {
      proxyOptions.secure = false;
      proxyOptions.agent = this.httpAgent;
    } else {
      throw new Error(`Unexpected protocol ${target.protocol}`);
    }

    if (proxyOptions.secure && this.options.clientSsl) {
      proxyOptions.target.key = this.options.clientSsl.key;
      proxyOptions.target.cert = this.options.clientSsl.cert;
      proxyOptions.target.ca = this.options.clientSsl.ca;
    }

    return proxyOptions;
  }

  async targetForReq(req) {
    var metricsTimerEnd = this.metrics.findTargetForReqSummary.startTimer();
    // return proxy target for a given url path
    var basePath = this.hostRouting ? "/" + parseHost(req) : "";
    var path = basePath + decodeURIComponent(new URL(req.url, "http://example.com").pathname);
    var route = await this._routes.getTarget(path);
    metricsTimerEnd();
    if (route) {
      return {
        prefix: route.prefix,
        target: route.data.target,
      };
    }
  }

  async targetForServeReq(req) {
    // resolve subdomain serve requests to user pod targets on a different port
    if (!this.serveDomain) return undefined;

    var host = parseHost(req);
    if (!host) return undefined;

    // match {username}.{serveDomain}
    var suffix = "." + this.serveDomain;
    if (!host.endsWith(suffix)) return undefined;

    var username = host.slice(0, -suffix.length);
    if (!username || username.includes(".")) return undefined;

    var userRoutePath = "/user/" + username;

    // look up the existing user route to find the pod IP
    // getTarget does prefix matching, so verify the match is the actual user route
    var route = await this._routes.getTarget(userRoutePath);
    if (!route || route.prefix !== userRoutePath) return undefined;

    // replace port with serve port
    var targetUrl = new URL(route.data.target);
    targetUrl.port = this.servePort;

    return {
      prefix: "",
      target: targetUrl.toString(),
      _isServe: true,
      _userRoutePrefix: userRoutePath,
    };
  }

  async _isSingleuserPod(remoteAddress) {
    // Check if the remote address belongs to a registered singleuser pod
    // by looking up all /user/* routes and comparing target IPs.
    var routes = await this._routes.getAll();
    for (var path of Object.keys(routes)) {
      if (!path.startsWith("/user/")) continue;
      try {
        var targetUrl = new URL(routes[path].target);
        if (targetUrl.hostname === remoteAddress) return path;
      } catch (e) {
        // skip malformed targets
      }
    }
    return null;
  }

  async handleApiProxy(req, res, cfg) {
    // cfg.proxyPath 로 들어온 요청을 cfg.apiUrl 로 프록시한다. 네트워크 기반 인증:
    // 등록된 singleuser pod IP 에서 온 요청에만 cfg.header 헤더에 실키를 주입한다
    // (singleuser 에는 키가 없으므로 dummy 를 무조건 덮어쓴다). NetworkPolicy 로도 제한할 것.
    var urlPath = decodeURIComponent(new URL(req.url, "http://example.com").pathname);
    if (!urlPath.startsWith(cfg.proxyPath + "/") && urlPath !== cfg.proxyPath) {
      return false;
    }

    if (!cfg.apiKey) {
      this.log.error("%s proxy: %s not configured", cfg.name, cfg.envName);
      fail(req, res, 500, cfg.name + " proxy not configured");
      return true;
    }

    var remoteAddress = req.socket.remoteAddress;
    // IPv4-mapped IPv6 정규화 (::ffff:10.0.1.5 -> 10.0.1.5)
    if (remoteAddress && remoteAddress.startsWith("::ffff:")) {
      remoteAddress = remoteAddress.slice(7);
    }
    var route = await this._isSingleuserPod(remoteAddress);
    if (!route) {
      this.log.warn("%s proxy: rejected request from unregistered IP %s", cfg.name, remoteAddress);
      fail(req, res, 403, "Forbidden");
      return true;
    }

    this.log.debug("%s proxy: request from %s (%s)", cfg.name, route, remoteAddress);

    // proxyPath 접두를 제거한 경로로 재작성한다.
    var strippedUrl = req.url.slice(cfg.proxyPath.length);
    if (!strippedUrl.startsWith("/")) strippedUrl = "/" + strippedUrl;
    req.url = strippedUrl;

    req.headers[cfg.header] = cfg.apiKey;

    delete req.headers["host"];

    var target = new URL(cfg.apiUrl);
    var isHttps = target.protocol.startsWith("https");
    var proxyOptions = {
      target: target,
      changeOrigin: true,
      secure: isHttps,
      agent: isHttps ? this.httpsAgent : this.httpAgent,
    };

    var that = this;
    this.proxy.web(req, res, proxyOptions, function (e) {
      that.log.error("%s proxy error: %s", cfg.name, e.message);
      if (!res.headersSent) {
        fail(req, res, 502, cfg.name + " API request failed");
      }
    });

    return true;
  }

  updateLastActivity(prefix) {
    var metricsTimerEnd = this.metrics.lastActivityUpdatingSummary.startTimer();
    var routes = this._routes;

    return routes
      .get(prefix)
      .then(function (result) {
        if (result) {
          return routes.update(prefix, { last_activity: new Date() });
        }
      })
      .then(metricsTimerEnd);
  }

  _handleProxyErrorDefault(code, kind, req, res) {
    // called when no custom error handler is registered,
    // or is registered and doesn't work
    if (res.writableEnded) return; // response already done
    if (!res.headersSent && res.writeHead) res.writeHead(code);
    if (res.write) res.write(http.STATUS_CODES[code]);
    if (res.end) res.end();
  }

  handleProxyError(code, kind, req, res, e) {
    // called when proxy itself has an error
    // so far, just 404 for no target and 503 for target not responding
    // custom error server gets `/CODE?url=/escapedUrl/`, e.g.
    // /404?url=%2Fuser%2Ffoo

    var errMsg = "";
    this.metrics.requestsProxyCount.labels(code).inc();
    if (e) {
      // avoid stack traces on known not-our-problem errors:
      // ECONNREFUSED, EHOSTUNREACH (backend isn't there)
      // ECONNRESET, ETIMEDOUT (backend is there, but didn't respond)
      switch (e.code) {
        case "ECONNREFUSED":
        case "ECONNRESET":
        case "EHOSTUNREACH":
        case "ETIMEDOUT":
          errMsg = e.message;
          break;
        default:
          // logging the error object shows a stack trace.
          // Anything that gets here is an unknown error,
          // so log more info.
          errMsg = e;
      }
    }
    this.log.error("%s %s %s %s", code, req.method, _logUrl(req.url), errMsg);
    if (!res) {
      this.log.debug("Socket error, no response to send");
      // socket-level error, no response to build
      return;
    }
    if (kind === "ws") {
      if (!res.writableEnded) {
        // send empty http response with status
        res.write(`HTTP/${req.httpVersion} ${code}\r\nContent-Length: 0\r\n\r\n`);
      }
      // http-proxy-3 calls res.destroySoon() after we return from here
      return;
    }
    if (this.errorTarget) {
      // error request is $errorTarget/$code?url=$requestUrl
      var options = this.proxyOptsForTarget(new URL(this.errorTarget));

      options.method = "GET";

      options.target.searchParams.set("url", req.url);
      options.target.pathname = options.target.pathname + code.toString();

      var url = "";
      if (options.target.socketPath) {
        options.target.hostname = "localhost";
        url = options.target.toString().substring(5); // chop off unix+
      } else {
        url = options.target.toString();
      }

      this.log.debug("Requesting custom error page: %s", url);

      var errorRequest = (options.secure ? https : http).request(
        url,
        options.target,
        (upstream) => {
          if (res.writableEnded) {
            // response already done
            // make sure to consume upstream;
            upstream.resume();
            return;
          }
          ["content-type", "content-encoding"].map((key) => {
            if (!upstream.headers[key]) return;
            if (res.setHeader) res.setHeader(key, upstream.headers[key]);
          });
          if (res.writeHead) res.writeHead(code);
          upstream.on("data", (data) => {
            if (res.write && !res.writableEnded) res.write(data);
          });
          upstream.on("end", () => {
            if (res.end) res.end();
          });
        }
      );
      errorRequest.on("error", (e) => {
        // custom error failed, fallback on default
        this.log.error("Failed to get custom error page: %s", e);
        this._handleProxyErrorDefault(code, kind, req, res);
      });
      errorRequest.end();
    } else if (this.errorPath) {
      var filename = path.join(this.errorPath, code.toString() + ".html");
      if (!fs.existsSync(filename)) {
        this.log.debug("No error file %s", filename);
        filename = path.join(this.errorPath, "error.html");
        if (!fs.existsSync(filename)) {
          this.log.error("No error file %s", filename);
          this._handleProxyErrorDefault(code, kind, req, res);
          return;
        }
      }
      fs.readFile(filename, (err, data) => {
        if (err) {
          this.log.error("Error reading %s %s", filename, err);
          this._handleProxyErrorDefault(code, kind, req, res);
          return;
        }
        if (!res.writable) return; // response already done
        if (res.writeHead) res.writeHead(code, { "Content-Type": "text/html" });
        if (res.write) res.write(data);
        if (res.end) res.end();
      });
    } else {
      this._handleProxyErrorDefault(code, kind, req, res);
    }
  }

  handleProxy(kind, req, res) {
    // proxy any request
    var that = this;

    // handleProxy is invoked by handleProxyWeb and handleProxyWs, which pass
    // different arguments to handleProxy.
    // - handleProxyWeb: args = [req, res]
    // - handleProxyWs: args = [req, socket, head]
    var args = Array.prototype.slice.call(arguments, 1);

    // get the proxy target: try serve path first, then normal routing
    return this.targetForServeReq(req)
      .then((serveMatch) => serveMatch || this.targetForReq(req))
      .then((match) => {
        if (!match) {
          that.handleProxyError(404, kind, req, res);
          return;
        }

        if (kind === "web") {
          that.emit("proxyRequest", req, res);
        } else {
          that.emit("proxyRequestWs", req, res, args[2]);
        }
        var prefix = match.prefix;
        var target = match.target;
        // for serve requests, track activity on the original user route
        var activityPrefix = match._isServe ? match._userRoutePrefix : prefix;
        that.log.debug("PROXY %s %s to %s", kind.toUpperCase(), _logUrl(req.url), target);

        // add CORS headers for serve domain responses
        if (match._isServe && kind === "web") {
          var origWriteHead = res.writeHead;
          res.writeHead = function (statusCode, headers) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            return origWriteHead.apply(res, arguments);
          };
        }

        // serve requests always strip prefix; normal requests respect includePrefix
        if (match._isServe) {
          req.url = req.url.slice(prefix.length);
          if (!req.url.startsWith("/")) req.url = "/" + req.url;
        } else if (!that.includePrefix) {
          req.url = req.url.slice(prefix.length);
        }

        target = new URL(target);
        var proxyOptions = this.proxyOptsForTarget(target);

        // Vite 등 dev server는 allowedHosts 검증으로 인식되지 않는 Host를 403으로 거부한다.
        // 기본적으로 프록시는 원본 Host(예: user.dev.jitda.io)를 그대로 전달하므로,
        // serve 요청 시 Host 헤더를 타겟 주소로 재작성한다.
        if (match._isServe) {
          proxyOptions.changeOrigin = true;
        }

        args.push(proxyOptions);

        // add error handling
        args.push(function (e) {
          that.handleProxyError(503, kind, req, res, e);
        });

        // dispatch the actual method, either:
        // - proxy.web(req, res, options, errorHandler)
        // - proxy.ws(req, socket, head, options, errorHandler)
        that.proxy[kind].apply(that.proxy, args);

        // update timestamp on any request/reply data as well (this includes websocket data)
        req.on("data", function () {
          that.updateLastActivity(activityPrefix);
        });

        res.on("data", function () {
          that.updateLastActivity(activityPrefix);
        });

        if (kind === "web") {
          // update last activity on completion of the request
          // only consider 'successful' requests activity
          // A flood of invalid requests such as 404s or 403s
          // or 503s because the endpoint is down
          // shouldn't make it look like the endpoint is 'active'

          // we no longer register activity at the *start* of the request
          // because at that point we don't know if the endpoint is even available
          res.on("finish", function () {
            // (don't count redirects...but should we?)
            if (res.statusCode < 300) {
              that.updateLastActivity(activityPrefix);
            } else {
              that.log.debug(
                "Not recording activity for status %s on %s",
                res.statusCode,
                activityPrefix
              );
            }
          });
        }
      })
      .catch(function (e) {
        if (res.finished) throw e;
        that.handleProxyError(500, kind, req, res, e);
      });
  }

  handleProxyWs(req, socket, head) {
    // Proxy a websocket request
    this.metrics.requestsWsCount.inc();
    return this.handleProxy("ws", req, socket, head);
  }

  _isServeHost(req) {
    if (!this.serveDomain) return false;
    var host = parseHost(req);
    return host && host.endsWith("." + this.serveDomain);
  }

  async handleProxyWeb(req, res) {
    // Handle CORS preflight for serve domain requests.
    // Only short-circuit when the host is a *.{serveDomain} subdomain AND the
    // subdomain actually resolves to a registered user route (i.e. a real
    // preview target). The bare {serveDomain} host and non-user subdomains
    // (e.g. the hub at opencode.dev.jitda.io) fall through so their own
    // upstream can respond with the correct CORS headers.
    if (req.method === "OPTIONS" && this._isServeHost(req)) {
      var serveMatch = await this.targetForServeReq(req);
      if (serveMatch) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }
    }
    this.handleHealthCheck(req, res);
    if (res.finished) return;

    // 외부 LLM API 프록시가 일반 라우팅보다 먼저 가로챈다.
    for (var cfg of this.apiProxies) {
      if (await this.handleApiProxy(req, res, cfg)) return;
    }

    // Proxy a web request
    this.metrics.requestsWebCount.inc();
    return this.handleProxy("web", req, res);
  }

  handleHealthCheck(req, res) {
    if (req.url === "/_chp_healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(JSON.stringify({ status: "OK" }));
      res.end();
    }
  }

  handleMetrics(req, res) {
    if (req.url === "/metrics") {
      return this.metrics.render(res);
    }
    fail(req, res, 404);
  }

  handleApiRequest(req, res) {
    // Handle a request to the REST API
    if (res) {
      res.on("finish", () => {
        this.metrics.requestsApiCount.labels(res.statusCode).inc();
        this.logResponse(req, res);
      });
    }
    var args = [req, res];
    function pushPathArg(arg) {
      args.push(arg === undefined ? arg : decodeURIComponent(arg));
    }
    var path = new URL(req.url, "https://example.com").pathname;
    for (var i = 0; i < this.apiHandlers.length; i++) {
      var pat = this.apiHandlers[i][0];
      var match = pat.exec(path);
      if (match) {
        var handlers = this.apiHandlers[i][1];
        var handler = handlers[req.method.toLowerCase()];
        if (!handler) {
          // 405 on found resource, but not found method
          fail(req, res, 405, "Method not supported");
          return Promise.resolve();
        }
        match.slice(1).forEach(pushPathArg);
        return handler.apply(handler, args) || Promise.resolve();
      }
    }
    fail(req, res, 404);
  }
}

export default ConfigurableProxy;
