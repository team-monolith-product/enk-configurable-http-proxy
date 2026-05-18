"use strict";

import { GlideClient } from "@valkey/valkey-glide";
import * as trie from "./trie.js";

var NotImplemented = function (name) {
  return {
    name: "NotImplementedException",
    message: "method '" + name + "' not implemented",
  };
};

export class BaseStore {
  // "abstract" methods
  getTarget(path) {
    throw NotImplemented("getTarget");
  }
  getAll() {
    throw NotImplemented("getAll");
  }
  add(path, data) {
    throw NotImplemented("add");
  }
  update(path, data) {
    throw NotImplemented("update");
  }
  remove(path) {
    throw NotImplemented("remove");
  }

  get(path) {
    // default get implementation derived from getAll
    // only needs overriding if a more efficient implementation is available
    path = this.cleanPath(path);
    return this.getAll().then((routes) => routes[path]);
  }

  cleanPath(path) {
    return trie.trimPrefix(path);
  }
}

export class MemoryStore extends BaseStore {
  constructor() {
    super();
    this.routes = {};
    this.urls = new trie.URLTrie();
  }

  get(path) {
    return Promise.resolve(this.routes[this.cleanPath(path)]);
  }

  getTarget(path) {
    return Promise.resolve(this.urls.get(path));
  }

  getAll() {
    return Promise.resolve(this.routes);
  }

  add(path, data) {
    path = this.cleanPath(path);
    this.routes[path] = data;
    this.urls.add(path, data);
    return Promise.resolve(null);
  }

  update(path, data) {
    Object.assign(this.routes[this.cleanPath(path)], data);
  }

  remove(path) {
    path = this.cleanPath(path);
    var route = this.routes[path];
    delete this.routes[path];
    this.urls.remove(path);
    return Promise.resolve(route);
  }
}

export class ValkeyStore extends BaseStore {
  constructor(options = {}) {
    super();
    this.log = options.log;

    const u = new URL(options.valkeyUrl || process.env.VALKEY_URL);
    this._address = { host: u.hostname, port: parseInt(u.port, 10) };
    this._useTLS = u.protocol === "rediss:";

    const keyPrefix = options.valkeyKeyPrefix || process.env.VALKEY_KEY_PREFIX || "chp";
    this.routesKey = `${keyPrefix}:routes`;

    const password = options.valkeyAuthToken || process.env.VALKEY_AUTH_TOKEN;
    this._credentials = password && { password };
    this._extraConfig = options.valkeyConfig || {};

    this.ready = this._initialize().catch(this._onInitError.bind(this));
  }

  async _initialize() {
    this.client = await GlideClient.createClient({
      addresses: [this._address],
      useTLS: this._useTLS,
      ...(this._credentials ? { credentials: this._credentials } : {}),
      ...this._extraConfig,
    });
  }

  _onInitError(err) {
    if (this.log) this.log.error("ValkeyStore: initialization failed: %s", err.message);
    throw err;
  }

  // CHP 의 inactive_since 필터링이 last_activity 와 Date 비교를 하므로
  // ISO 문자열을 Date 로 복원.
  _parse(json) {
    const data = JSON.parse(json);
    if (data.last_activity) data.last_activity = new Date(data.last_activity);
    return data;
  }

  async getAll() {
    await this.ready;
    const records = await this.client.hgetall(this.routesKey);
    const result = {};
    for (const { field, value } of records) {
      result[field] = this._parse(value);
    }
    return result;
  }

  async get(path) {
    await this.ready;
    const json = await this.client.hget(this.routesKey, this.cleanPath(path));
    return json ? this._parse(json) : undefined;
  }

  // Valkey 자체에 prefix 매칭 명령이 없어 부모 path 후보를 클라이언트에서
  // 만들어 HMGET 으로 한 번에 조회한 뒤 가장 긴 매치를 반환한다.
  async getTarget(path) {
    await this.ready;
    const candidates = parentPaths(this.cleanPath(path));
    const values = await this.client.hmget(this.routesKey, candidates);
    for (let i = 0; i < candidates.length; i++) {
      if (values[i] != null) {
        return { prefix: candidates[i], data: this._parse(values[i]) };
      }
    }
    return undefined;
  }

  async add(path, data) {
    await this.ready;
    await this.client.hset(this.routesKey, { [this.cleanPath(path)]: JSON.stringify(data) });
    return null;
  }

  // updateLastActivity 처럼 fire-and-forget 으로 호출되는 update 가 race 로
  // 사라진 key 에 대해 실행될 수 있으므로 missing key 는 silent no-op.
  async update(path, data) {
    await this.ready;
    const cleaned = this.cleanPath(path);
    const existingJson = await this.client.hget(this.routesKey, cleaned);
    if (!existingJson) return;
    const merged = Object.assign(this._parse(existingJson), data);
    await this.client.hset(this.routesKey, { [cleaned]: JSON.stringify(merged) });
  }

  async remove(path) {
    await this.ready;
    const cleaned = this.cleanPath(path);
    const existingJson = await this.client.hget(this.routesKey, cleaned);
    await this.client.hdel(this.routesKey, [cleaned]);
    return existingJson ? this._parse(existingJson) : undefined;
  }

  async close() {
    if (this.client) this.client.close();
  }
}

// "/foo/bar/baz" -> ["/foo/bar/baz", "/foo/bar", "/foo", "/"]
function parentPaths(cleaned) {
  const result = [];
  let p = cleaned;
  while (p.length > 1) {
    result.push(p);
    p = p.slice(0, p.lastIndexOf("/")) || "/";
  }
  result.push("/");
  return result;
}
