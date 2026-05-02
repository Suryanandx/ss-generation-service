import Fastify from "fastify";
import { config } from "./config.js";
import { getRabbitChannel } from "./queue/rabbit.js";
import { startQueueWorkers } from "./queue/worker.js";
import { registerApiRoutes } from "./api/routes.js";
import type { QueueJobPayload } from "./types.js";

const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 }); // 25 MB — base64 images can be 5–15 MB
let lastDashboardWorkerActivityAt = 0;

function requireServiceAuth(authHeader?: string) {
  if (!config.serviceToken) return true;
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "");
  return token === config.serviceToken;
}

app.addHook("onRequest", async (req, reply) => {
  if (req.url.startsWith("/health") || req.url.startsWith("/ready")) return;
  if (!requireServiceAuth(req.headers.authorization)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/health", async () => ({ ok: true }));
app.get("/ready", async (_req, reply) => {
  try {
    await getRabbitChannel();
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false, error: "RabbitMQ unavailable" });
  }
});

await registerApiRoutes(app);

async function triggerDashboardWorkerTick(payload: QueueJobPayload) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.workerToken) headers["x-worker-token"] = config.workerToken;

  const res = await fetch(
    `${config.dashboardBaseUrl}/api/internal/generation-worker?limit=1`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId: payload.jobId }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `dashboard worker failed (${res.status}) for job ${payload.jobId}: ${body.slice(0, 180)}`
    );
  }

  const data = (await res.json().catch(() => ({}))) as {
    processedCount?: number;
    preferredJob?: { id?: string; status?: string; batchId?: string };
  };
  const processedCount = Number(data?.processedCount || 0);
  if (processedCount > 0) {
    lastDashboardWorkerActivityAt = Date.now();
  }
  if (processedCount < 1) {
    const preferredStatus = String(data?.preferredJob?.status || "");
    const alreadyHandledStatuses = new Set([
      "PICKED",
      "SUBMITTED",
      "QA_CHECK",
      "COMPLETED",
      "FAILED",
      "DEAD_LETTER",
    ]);
    if (!alreadyHandledStatuses.has(preferredStatus)) {
      throw new Error(
        `dashboard worker processed 0 jobs for queue message ${payload.jobId} (preferred status: ${
          preferredStatus || "unknown"
        })`
      );
    }
  }
}

async function recoverySweepTick() {
  if (Date.now() - lastDashboardWorkerActivityAt < config.recoverySweepIdleGuardMs) {
    return { skipped: true, processedCount: 0 };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.workerToken) headers["x-worker-token"] = config.workerToken;
  const res = await fetch(`${config.dashboardBaseUrl}/api/internal/generation-worker?limit=1`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`recovery sweep failed (${res.status}): ${body.slice(0, 180)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { processedCount?: number };
  const processedCount = Number(data?.processedCount || 0);
  if (processedCount > 0) {
    lastDashboardWorkerActivityAt = Date.now();
  }
  return { skipped: false, processedCount };
}

app
  .listen({ port: config.port, host: config.host })
  .then(async () => {
    app.log.info(`generation-service listening on ${config.host}:${config.port}`);
    if (process.env.RUN_WORKER === "true") {
      await startQueueWorkers(async (payload) => {
        await triggerDashboardWorkerTick(payload);
      });
      app.log.info("queue workers started");
      let nextSweepDelayMs = config.recoverySweepMinMs;
      const runRecoverySweep = async () => {
        try {
          const result = await recoverySweepTick();
          if (result.processedCount > 0) {
            nextSweepDelayMs = config.recoverySweepMinMs;
          } else {
            nextSweepDelayMs = Math.min(config.recoverySweepMaxMs, nextSweepDelayMs * 2);
          }
        } catch (error) {
          nextSweepDelayMs = Math.min(config.recoverySweepMaxMs, nextSweepDelayMs * 2);
          app.log.warn({ err: error }, "recovery sweep tick failed");
        } finally {
          setTimeout(runRecoverySweep, nextSweepDelayMs);
        }
      };
      setTimeout(runRecoverySweep, nextSweepDelayMs);
      app.log.info(
        `recovery sweep started (adaptive ${config.recoverySweepMinMs}-${config.recoverySweepMaxMs}ms)`
      );
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
