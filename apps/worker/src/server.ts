// Lumen sync worker — a tiny Hono app that stores a single settings snapshot
// per device behind a bearer token. Runs on Cloudflare Workers (KV-backed) or
// any JS runtime with a compatible key-value store.
//
// Endpoints:
//   GET  /health    -> { ok: true }
//   GET  /snapshot  -> 200 SyncSnapshot JSON, or 404 if none
//   PUT  /snapshot  -> 200 { ok: true }  (body = SyncSnapshot)
//
// Auth: `Authorization: Bearer <LUMEN_TOKEN>`. The token is read from the
// LUMEN_TOKEN env var (Cloudflare secret) or a fallback for local dev.

import { Hono } from "hono";

interface Env {
  LUMEN_KV: KVNamespace;
  LUMEN_TOKEN: string;
}

const KEY = "snapshot:global";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "lumen-sync", version: 1 }));

app.use("/snapshot/*", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  const expected = c.env.LUMEN_TOKEN;
  if (!expected) {
    return c.json({ error: "LUMEN_TOKEN not set on the worker" }, 500);
  }
  if (auth !== `Bearer ${expected}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/snapshot", async (c) => {
  const raw = await c.env.LUMEN_KV.get(KEY);
  if (!raw) return c.json({ error: "no snapshot yet" }, 404);
  return c.json(JSON.parse(raw));
});

app.put("/snapshot", async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid body" }, 400);
  }
  await c.env.LUMEN_KV.put(KEY, JSON.stringify(body));
  return c.json({ ok: true });
});

export default app;
