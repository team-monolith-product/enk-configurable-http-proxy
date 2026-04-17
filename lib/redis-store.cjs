"use strict";

// Redis-backed storage backend for configurable-http-proxy.
//
// Persists the routing table in a Redis hash so routes survive proxy restarts.
// Maintains a local URLTrie (hydrated from Redis on startup) for prefix-match
// lookups in the request hot path.
//
// Loaded via the `--storage-backend ./lib/redis-store.cjs` CLI flag. CHP's
// `loadStorage()` uses `require()`, so this file is CommonJS. `URLTrie` lives
// in `lib/trie.js` (ESM), so it is brought in via a memoized dynamic
// `import()` during the first hydration. `trimPrefix` is duplicated locally
// so that the synchronous `cleanPath()` has no initialization-order hazard.
//
// Single-proxy assumption: writes update the local trie directly. Multi-proxy
// synchronization (Redis Pub/Sub or keyspace notifications) is intentionally
// out of scope for this iteration and tracked as follow-up work.

const Redis = require("ioredis");

const DEFAULT_URL = "redis://localhost:6379";
const DEFAULT_KEY_PREFIX = "chp";

// Mirror of trie.trimPrefix — duplicated so cleanPath() does not depend on
// the dynamically imported trie module being ready.
function trimPrefix(prefix) {
  if (prefix.length === 0 || prefix[0] !== "/") {
    prefix = "/" + prefix;
  }
  if (prefix.length > 1 && prefix[prefix.length - 1] === "/") {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

class RedisStore {
  constructor(options = {}) {
    this.log = options.log;

    const url = options.redisUrl || process.env.REDIS_URL || DEFAULT_URL;
    const keyPrefix = options.redisKeyPrefix || process.env.REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX;
    this.routesKey = `${keyPrefix}:routes`;

    // Flag that the client was injected (e.g. by tests via ioredis-mock). In
    // that case close() should not call quit() on a shared client.
    this._ownsClient = !options.redisClient;
    this.client = options.redisClient || new Redis(url, options.redisOptions || {});

    this._onError = (err) => {
      if (this.log) this.log.error("RedisStore client error: %s", err.message);
    };
    this._onReady = () => {
      // Re-hydrate after reconnects so the local trie matches Redis state.
      // First "ready" event is ignored because the explicit hydration below
      // already covers the initial connection.
      if (this._firstReadyHandled) {
        this.ready = this._hydrate().catch(this._onHydrateError.bind(this));
      } else {
        this._firstReadyHandled = true;
      }
    };
    this.client.on("error", this._onError);
    this.client.on("ready", this._onReady);

    this.ready = this._hydrate().catch(this._onHydrateError.bind(this));
  }

  _onHydrateError(err) {
    if (this.log) this.log.error("RedisStore: hydration failed: %s", err.message);
    throw err;
  }

  async _hydrate() {
    const trie = await this._loadTrieModule();
    const routes = await this.client.hgetall(this.routesKey);
    const next = new trie.URLTrie();
    for (const [path, json] of Object.entries(routes || {})) {
      const data = this._safeParse(path, json);
      if (data !== undefined) {
        next.add(path, data);
      }
    }
    this.urls = next;
  }

  _loadTrieModule() {
    if (!this._trieModulePromise) {
      this._trieModulePromise = import("./trie.js");
    }
    return this._trieModulePromise;
  }

  _safeParse(path, json) {
    if (json === null || json === undefined) return undefined;
    try {
      return JSON.parse(json);
    } catch (err) {
      if (this.log) this.log.error("RedisStore: failed to parse route %s: %s", path, err.message);
      return undefined;
    }
  }

  cleanPath(path) {
    return trimPrefix(path);
  }

  async getTarget(path) {
    await this.ready;
    return this.urls.get(path);
  }

  async getAll() {
    await this.ready;
    const routes = await this.client.hgetall(this.routesKey);
    const result = {};
    for (const [path, json] of Object.entries(routes || {})) {
      const data = this._safeParse(path, json);
      if (data !== undefined) {
        result[path] = data;
      }
    }
    return result;
  }

  async get(path) {
    // Bypasses the local URLTrie because the trie answers prefix queries, not
    // exact-key lookups; HGET on the Redis hash is an O(1) exact lookup.
    await this.ready;
    const cleaned = this.cleanPath(path);
    const json = await this.client.hget(this.routesKey, cleaned);
    return this._safeParse(cleaned, json);
  }

  async add(path, data) {
    await this.ready;
    const cleaned = this.cleanPath(path);
    await this.client.hset(this.routesKey, cleaned, JSON.stringify(data));
    this.urls.add(cleaned, data);
    return null;
  }

  // Note: unlike MemoryStore.update (which throws on a missing path), this
  // merges into an empty record if the path is not yet stored. The lenient
  // behavior is intentional — it makes update() idempotent when the caller
  // cannot be sure whether add() has already run, which matters for proxies
  // whose lifecycle is not strictly serialized with the Hub.
  async update(path, data) {
    await this.ready;
    const cleaned = this.cleanPath(path);
    const existingJson = await this.client.hget(this.routesKey, cleaned);
    const existing = this._safeParse(cleaned, existingJson) || {};
    const merged = { ...existing, ...data };
    await this.client.hset(this.routesKey, cleaned, JSON.stringify(merged));
    this.urls.add(cleaned, merged);
  }

  async remove(path) {
    await this.ready;
    const cleaned = this.cleanPath(path);
    // Pipeline HGET + HDEL to collapse the two round-trips into one. The
    // window between read and delete shrinks to near-zero, and an already-
    // absent key just makes HDEL a no-op.
    const [[getErr, existingJson], [delErr]] = await this.client
      .pipeline()
      .hget(this.routesKey, cleaned)
      .hdel(this.routesKey, cleaned)
      .exec();
    if (getErr) throw getErr;
    if (delErr) throw delErr;
    this.urls.remove(cleaned);
    return this._safeParse(cleaned, existingJson);
  }

  async close() {
    this.client.off("error", this._onError);
    this.client.off("ready", this._onReady);
    if (this._ownsClient) {
      await this.client.quit();
    }
  }
}

module.exports = RedisStore;
