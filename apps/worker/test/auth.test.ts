import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/server";

const FIXTURE = "lumen-test-value";

function createKvStub() {
  const store = new Map<string, string>();
  return {
    kv: {
      get: async (key: string): Promise<string | null> => store.get(key) ?? null,
      put: async (key: string, value: string): Promise<void> => {
        store.set(key, value);
      },
    },
    store,
  };
}

function makeEnv() {
  const { kv, store } = createKvStub();
  return { env: { LUMEN_KV: kv, LUMEN_TOKEN: FIXTURE }, store };
}

function putRequest(body: string, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return new Request("https://worker.test/snapshot", {
    method: "PUT",
    headers,
    body,
  });
}

const validSnapshot = JSON.stringify({
  version: 1,
  settings: { targetLang: "zh", rules: [] },
  updatedAt: new Date().toISOString(),
});

describe("worker /snapshot auth + validation", () => {
  let env: ReturnType<typeof makeEnv>["env"];

  beforeEach(() => {
    env = makeEnv().env;
  });

  it("rejects a missing Bearer token with 401", async () => {
    const res = await app.fetch(putRequest(validSnapshot), env);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong Bearer token with 401", async () => {
    const res = await app.fetch(putRequest(validSnapshot, "wrong-token"), env);
    expect(res.status).toBe(401);
  });

  it("accepts a valid token + valid snapshot with 200", async () => {
    const res = await app.fetch(putRequest(validSnapshot, FIXTURE), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects an oversized body with 413", async () => {
    const huge = JSON.stringify({
      version: 1,
      settings: { blob: "x".repeat(600 * 1024) },
      updatedAt: new Date().toISOString(),
    });
    const res = await app.fetch(putRequest(huge, FIXTURE), env);
    expect(res.status).toBe(413);
  });

  it("rejects a non-object body with 400", async () => {
    const res = await app.fetch(putRequest(JSON.stringify("hello"), FIXTURE), env);
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await app.fetch(putRequest("{not json", FIXTURE), env);
    expect(res.status).toBe(400);
  });

  it("GET /health is public", async () => {
    const res = await app.fetch(new Request("https://worker.test/health"), env);
    expect(res.status).toBe(200);
  });
});
