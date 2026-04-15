# ss-generation-service

Standalone HTTP + worker service for **image generation** jobs. It accepts authenticated requests from the dashboard, enqueues work on **RabbitMQ**, calls the **Muapi** provider, and reports results back to the dashboard via webhooks.

## Layout

- **`generation-service/`** — Node 20 + TypeScript + Fastify service (API, queue consumers, Muapi integration).

## Prerequisites

- Node.js20+
- A reachable **RabbitMQ** instance (URL in `RABBITMQ_URL`)
- **Muapi** credentials (`MUAPI_BASE_URL`, `MUAPI_API_KEY`)
- The dashboard base URL and shared secrets for service ↔ dashboard auth (see `.env.example`)

## Quick start

```bash
cd generation-service
cp .env.example .env
# edit .env with real values

npm ci
npm run dev
```

Default HTTP port: **4040** (override with `PORT`).

## Worker mode

The same process can run **queue consumers** when `RUN_WORKER=true`. In production you often run:

- one or more **API** replicas with `RUN_WORKER=false` (or unset), and  
- one or more **worker** replicas with `RUN_WORKER=true`.

See `generation-service/.env.example` for related tuning (prefetch, recovery sweep, etc.).

## Docker

From `generation-service/`:

```bash
docker build -t ss-generation-service .
```

## Security

- Never commit `.env` files or API keys.  
- Use `GEN_SERVICE_TOKEN` for inbound requests from the dashboard and `GEN_WORKER_TOKEN` for internal worker callbacks as documented in `.env.example`.

## Wiring the dashboard (e.g. curation.valnoraelric.com)

Traffic is **server-to-server**: the Next.js app calls the generation service with `fetch`; the browser does not talk to Fly directly, so you do not need CORS on the generation service for the UI.

**On the dashboard host** (Vercel, etc.), set:

- `GEN_SERVICE_URL` — public `https` URL of the Fly app (no trailing slash), e.g. `https://your-gen-app.fly.dev`
- `GEN_SERVICE_TOKEN` — same value as the generation service’s `GEN_SERVICE_TOKEN`
- `GEN_WORKER_TOKEN` — same value as the generation service’s `GEN_WORKER_TOKEN`

**On Fly** (`fly secrets set`), set at least:

- `DASHBOARD_BASE_URL=https://curation.valnoraelric.com` (no trailing slash)
- `GEN_SERVICE_TOKEN`, `GEN_WORKER_TOKEN` — match the dashboard
- `RABBITMQ_URL`, `MUAPI_*`, and run workers with `RUN_WORKER=true` on worker machines

The dashboard route `/api/internal/generation-worker` is already excluded from the session middleware so the worker can call it with `x-worker-token` only.

## Related repository

The dashboard app that enqueues jobs and consumes completion webhooks lives in the main **kpop-dashboard** project (sibling monorepo), not in this repo.
