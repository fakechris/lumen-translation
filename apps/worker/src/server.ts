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
import type { Context, Next } from "hono";

interface Env {
  LUMEN_KV: KVNamespace;
  LUMEN_TOKEN: string;
}

const KEY = "snapshot:global";

/** Reject snapshots larger than this before parsing (defense against abuse). */
const MAX_BODY_BYTES = 512 * 1024;

const encoder = new TextEncoder();

/**
 * Constant-time string comparison for the bearer token. A plain `===` returns as
 * soon as the first differing byte is found, leaking token bytes through timing.
 * We fold the length difference into the accumulator and always iterate over the
 * expected token's length, so neither the value nor the length of the provided
 * token is revealed by an early return.
 */
function timingSafeEqual(provided: string, expected: string): boolean {
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= (a[i] ?? 0) ^ b[i];
  }
  return diff === 0;
}

function isValidSnapshotShape(body: unknown): body is Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (typeof record.version !== "number") return false;
  const settings = record.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  return true;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "lumen-sync", version: 1 }));

// Hono's `/snapshot/*` wildcard does not match the bare `/snapshot` path, so we
// register the auth guard on both to avoid an auth bypass on the exact route.
const requireAuth = async (
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> => {
  const expected = c.env.LUMEN_TOKEN;
  if (!expected) {
    return c.json({ error: "LUMEN_TOKEN not set on the worker" }, 500);
  }
  const auth = c.req.header("Authorization") ?? "";
  const prefix = "Bearer ";
  const provided = auth.startsWith(prefix) ? auth.slice(prefix.length) : "";
  if (!timingSafeEqual(provided, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

app.use("/snapshot", requireAuth);
app.use("/snapshot/*", requireAuth);

app.get("/snapshot", async (c) => {
  const raw = await c.env.LUMEN_KV.get(KEY);
  if (!raw) return c.json({ error: "no snapshot yet" }, 404);
  return c.json(JSON.parse(raw));
});

app.put("/snapshot", async (c) => {
  const declaredLength = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "snapshot too large" }, 413);
  }

  const raw = await c.req.text();
  if (encoder.encode(raw).length > MAX_BODY_BYTES) {
    return c.json({ error: "snapshot too large" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  if (!isValidSnapshotShape(parsed)) {
    return c.json({ error: "invalid snapshot shape" }, 400);
  }

  await c.env.LUMEN_KV.put(KEY, JSON.stringify(parsed));
  return c.json({ ok: true });
});

export default app;
