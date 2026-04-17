import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const RedisStore = require("../lib/redis-store.cjs");
const RedisMock = require("ioredis-mock");

describe("RedisStore", function () {
  beforeEach(async function () {
    this.client = new RedisMock();
    this.subject = new RedisStore({ redisClient: this.client });
    await this.subject.ready;
  });

  afterEach(async function () {
    await this.client.flushall();
    await this.subject.close();
  });

  describe("get", function () {
    it("returns the data for the specified path", async function () {
      await this.subject.add("/myRoute", { test: "value" });
      const data = await this.subject.get("/myRoute");
      expect(data).toEqual({ test: "value" });
    });

    it("returns undefined when not found", async function () {
      const result = await this.subject.get("/wut");
      expect(result).toBe(undefined);
    });
  });

  describe("getTarget", function () {
    it("returns the target object for the path", async function () {
      await this.subject.add("/myRoute", { target: "http://localhost:8213" });
      const target = await this.subject.getTarget("/myRoute");
      expect(target.prefix).toEqual("/myRoute");
      expect(target.data.target).toEqual("http://localhost:8213");
    });

    it("returns longest prefix match", async function () {
      await this.subject.add("/parent", { target: "http://localhost:1" });
      await this.subject.add("/parent/child", { target: "http://localhost:2" });
      const target = await this.subject.getTarget("/parent/child/grandchild");
      expect(target.prefix).toEqual("/parent/child");
    });
  });

  describe("getAll", function () {
    it("returns all routes", async function () {
      await this.subject.add("/myRoute", { test: "value1" });
      await this.subject.add("/myOtherRoute", { test: "value2" });
      const routes = await this.subject.getAll();
      expect(Object.keys(routes).length).toEqual(2);
      expect(routes["/myRoute"]).toEqual({ test: "value1" });
      expect(routes["/myOtherRoute"]).toEqual({ test: "value2" });
    });

    it("returns a blank object when no routes defined", async function () {
      const routes = await this.subject.getAll();
      expect(routes).toEqual({});
    });
  });

  describe("add", function () {
    it("adds data to the store for the specified path", async function () {
      await this.subject.add("/myRoute", { test: "value" });
      const route = await this.subject.get("/myRoute");
      expect(route).toEqual({ test: "value" });
    });

    it("overwrites any existing values", async function () {
      await this.subject.add("/myRoute", { test: "value" });
      await this.subject.add("/myRoute", { test: "updatedValue" });
      const route = await this.subject.get("/myRoute");
      expect(route).toEqual({ test: "updatedValue" });
    });
  });

  describe("update", function () {
    it("merges supplied data with existing data", async function () {
      await this.subject.add("/myRoute", { version: 1, test: "value" });
      await this.subject.update("/myRoute", { version: 2 });
      const route = await this.subject.get("/myRoute");
      expect(route.version).toEqual(2);
      expect(route.test).toEqual("value");
    });

    it("merges into an empty record when path was not previously stored", async function () {
      await this.subject.update("/newRoute", { version: 1 });
      const route = await this.subject.get("/newRoute");
      expect(route).toEqual({ version: 1 });
    });
  });

  describe("remove", function () {
    it("removes a route from the table", async function () {
      await this.subject.add("/myRoute", { test: "value" });
      await this.subject.remove("/myRoute");
      const route = await this.subject.get("/myRoute");
      expect(route).toBe(undefined);
    });

    it("returns the removed route data", async function () {
      await this.subject.add("/myRoute", { test: "value" });
      const removed = await this.subject.remove("/myRoute");
      expect(removed).toEqual({ test: "value" });
    });

    it("does not throw when route is not defined", async function () {
      await expectAsync(this.subject.remove("/myRoute/foo/bar")).toBeResolved();
    });
  });

  describe("persistence across instances", function () {
    it("hydrates routes from Redis on a fresh store", async function () {
      await this.subject.add("/persisted", { target: "http://localhost:9999" });
      await this.subject.close();

      const reopened = new RedisStore({ redisClient: this.client });
      await reopened.ready;

      const route = await reopened.get("/persisted");
      expect(route).toEqual({ target: "http://localhost:9999" });

      const target = await reopened.getTarget("/persisted/anything");
      expect(target.prefix).toEqual("/persisted");

      await reopened.close();
    });
  });

  describe("path cleaning", function () {
    it("normalizes trailing slashes on add and lookup", async function () {
      await this.subject.add("/with-slash/", { test: "value" });
      const direct = await this.subject.get("/with-slash");
      expect(direct).toEqual({ test: "value" });
    });

    it("ensures leading slash is added", async function () {
      await this.subject.add("no-slash", { test: "value" });
      const route = await this.subject.get("/no-slash");
      expect(route).toEqual({ test: "value" });
    });
  });

  describe("failure handling", function () {
    it("rejects ready when initial hydration fails", async function () {
      const badClient = new RedisMock();
      badClient.hgetall = () => Promise.reject(new Error("ECONNREFUSED"));
      const store = new RedisStore({ redisClient: badClient });
      await expectAsync(store.ready).toBeRejectedWithError(/ECONNREFUSED/);
      await store.close();
    });

    it("skips corrupted JSON values when hydrating", async function () {
      await this.client.hset(this.subject.routesKey, "/bad", "not-json");
      await this.client.hset(
        this.subject.routesKey,
        "/good",
        JSON.stringify({ target: "http://localhost:1" })
      );

      const fresh = new RedisStore({ redisClient: this.client });
      await fresh.ready;

      const all = await fresh.getAll();
      expect(all["/good"]).toEqual({ target: "http://localhost:1" });
      expect(all["/bad"]).toBeUndefined();

      await fresh.close();
    });

    it("does not leak event listeners across close/reopen cycles", async function () {
      const client = new RedisMock();
      const initialErrorListeners = client.listenerCount("error");
      const initialReadyListeners = client.listenerCount("ready");

      for (let i = 0; i < 5; i++) {
        const store = new RedisStore({ redisClient: client });
        await store.ready;
        await store.close();
      }

      expect(client.listenerCount("error")).toEqual(initialErrorListeners);
      expect(client.listenerCount("ready")).toEqual(initialReadyListeners);
    });
  });

  describe("key prefix", function () {
    it("uses a configurable Redis key prefix", async function () {
      const otherClient = new RedisMock();
      const a = new RedisStore({ redisClient: otherClient, redisKeyPrefix: "tenant-a" });
      const b = new RedisStore({ redisClient: otherClient, redisKeyPrefix: "tenant-b" });
      await Promise.all([a.ready, b.ready]);

      await a.add("/route", { tenant: "a" });
      await b.add("/route", { tenant: "b" });

      expect(await a.get("/route")).toEqual({ tenant: "a" });
      expect(await b.get("/route")).toEqual({ tenant: "b" });

      await a.close();
      await b.close();
    });
  });
});
