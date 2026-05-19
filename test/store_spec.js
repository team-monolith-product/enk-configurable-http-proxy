import * as crypto from "node:crypto";
import { MemoryStore, ValkeyStore } from "../lib/store.js";

describe("MemoryStore", function () {
  beforeEach(function () {
    this.subject = new MemoryStore();
  });

  describe("get", function () {
    it("returns the data for the specified path", function (done) {
      this.subject.add("/myRoute", { test: "value" });

      this.subject.get("/myRoute").then(function (data) {
        expect(data).toEqual({ test: "value" });
        done();
      });
    });

    it("returns undefined when not found", function (done) {
      this.subject.get("/wut").then((result) => {
        expect(result).toBe(undefined);
        done();
      });
    });
  });

  describe("getTarget", function () {
    it("returns the target object for the path", function (done) {
      this.subject.add("/myRoute", { target: "http://localhost:8213" });

      this.subject.getTarget("/myRoute").then(function (target) {
        expect(target.prefix).toEqual("/myRoute");
        expect(target.data.target).toEqual("http://localhost:8213");
        done();
      });
    });
  });

  describe("getAll", function () {
    it("returns all routes", function (done) {
      this.subject.add("/myRoute", { test: "value1" });
      this.subject.add("/myOtherRoute", { test: "value2" });

      this.subject.getAll().then(function (routes) {
        expect(Object.keys(routes).length).toEqual(2);
        expect(routes["/myRoute"]).toEqual({ test: "value1" });
        expect(routes["/myOtherRoute"]).toEqual({ test: "value2" });
        done();
      });
    });

    it("returns a blank object when no routes defined", function (done) {
      this.subject.getAll().then(function (routes) {
        expect(routes).toEqual({});
        done();
      });
    });
  });

  describe("add", function () {
    it("adds data to the store for the specified path", function (done) {
      this.subject.add("/myRoute", { test: "value" });

      this.subject.get("/myRoute").then(function (route) {
        expect(route).toEqual({ test: "value" });
        done();
      });
    });

    it("overwrites any existing values", function (done) {
      this.subject.add("/myRoute", { test: "value" });
      this.subject.add("/myRoute", { test: "updatedValue" });

      this.subject.get("/myRoute").then(function (route) {
        expect(route).toEqual({ test: "updatedValue" });
        done();
      });
    });
  });

  describe("update", function () {
    it("merges supplied data with existing data", function (done) {
      this.subject.add("/myRoute", { version: 1, test: "value" });
      this.subject.update("/myRoute", { version: 2 });

      this.subject.get("/myRoute").then(function (route) {
        expect(route.version).toEqual(2);
        expect(route.test).toEqual("value");
        done();
      });
    });
  });

  describe("remove", function () {
    it("removes a route from the table", function (done) {
      this.subject.add("/myRoute", { test: "value" });
      this.subject.remove("/myRoute");

      this.subject.get("/myRoute").then(function (route) {
        expect(route).toBe(undefined);
        done();
      });
    });

    it("doesn't explode when route is not defined", function (done) {
      // would blow up if an error was thrown
      this.subject.remove("/myRoute/foo/bar").then(done);
    });
  });

  describe("hasRoute", function () {
    it("returns true when the path is found", function (done) {
      this.subject
        .add("/myRoute", { test: "value" })
        .then(() => this.subject.get("/myRoute"))
        .then((result) => {
          expect(result).toEqual({ test: "value" });
        })
        .then(done);
    });

    it("returns false when the path is not found", function (done) {
      this.subject
        .get("/wut")
        .then(function (result) {
          expect(result).toBe(undefined);
        })
        .then(done);
    });
  });
});

// MemoryStore 와 동일한 BaseStore 계약을 검증한다.
// CI 의 valkey service container (또는 로컬 redis-server) 가 필요.
describe("ValkeyStore", function () {
  beforeEach(async function () {
    this.subject = new ValkeyStore({
      valkeyKeyPrefix: `chp-test-${crypto.randomBytes(4).toString("hex")}`,
    });
    await this.subject.ready;
  });

  afterEach(async function () {
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
  });

  describe("persistence across instances", function () {
    it("hydrates routes from Valkey on a fresh store", async function () {
      await this.subject.add("/persisted", { target: "http://localhost:9999" });
      const prefix = this.subject.routesKey.replace(":routes", "");

      const reopened = new ValkeyStore({ valkeyKeyPrefix: prefix });
      await reopened.ready;
      try {
        const route = await reopened.get("/persisted");
        expect(route).toEqual({ target: "http://localhost:9999" });
        const target = await reopened.getTarget("/persisted/anything");
        expect(target.prefix).toEqual("/persisted");
      } finally {
        await reopened.close();
      }
    });
  });

  describe("path cleaning", function () {
    it("normalizes trailing slashes on add and lookup", async function () {
      await this.subject.add("/with-slash/", { test: "value" });
      const route = await this.subject.get("/with-slash");
      expect(route).toEqual({ test: "value" });
    });

    it("ensures leading slash is added", async function () {
      await this.subject.add("no-slash", { test: "value" });
      const route = await this.subject.get("/no-slash");
      expect(route).toEqual({ test: "value" });
    });
  });
});
