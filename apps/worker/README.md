# Lumen Sync Worker

A self-hostable settings-sync backend for Lumen Translation. Runs on **Cloudflare Workers** (free tier is plenty) using a KV namespace for storage. Any client of `@lumen/sync`'s `createWorkerBackend` can talk to it.

## Deploy on Cloudflare

```bash
cd apps/worker
npm install -g wrangler   # if not installed
wrangler login
wrangler kv:namespace create LUMEN_KV     # copy the id into wrangler.toml
wrangler secret put LUMEN_TOKEN           # paste a strong bearer token
wrangler deploy
```

Your sync URL will be `https://lumen-sync.<your-subdomain>.workers.dev`. In Lumen's settings, choose the Worker sync backend, enter that URL and the token you set.

## Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/health` | none | `{ ok: true }` |
| GET | `/snapshot` | Bearer | `SyncSnapshot` or 404 |
| PUT | `/snapshot` | Bearer | `{ ok: true }` |

## Docker / other runtimes

The Hono app is runtime-portable. To run on Node/Bun, swap the KV binding for your own key-value store (e.g. `unstorage`, a JSON file, or Redis) and provide `LUMEN_TOKEN` via env. The handler logic stays identical.
