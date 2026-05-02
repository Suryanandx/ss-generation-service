import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publishJob } from "../queue/rabbit.js";
import { registerSeedanceRoutes } from "./seedance.js";
import type { QueueJobPayload } from "../types.js";

export async function registerApiRoutes(app: FastifyInstance) {
  await registerSeedanceRoutes(app);
  const baseSchema = z.object({
    batchId: z.string().min(1),
    jobId: z.string().min(1),
    collectionId: z.string().min(1),
    styleId: z.string().min(1),
    prompt: z.string().optional(),
    modelId: z.string().optional(),
    referenceImageUrl: z.string().url().optional(),
  });

  app.post("/v1/generations/base", async (req, reply) => {
    const parsed = baseSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
    }
    const payload: QueueJobPayload = { ...parsed.data, type: "BASE", attempt: 0 };
    await publishJob("job.base", payload);
    return reply.send({ ok: true, queued: true, batchId: payload.batchId, jobId: payload.jobId });
  });

  const posesSchema = z.object({
    batchId: z.string().min(1),
    collectionId: z.string().min(1),
    styleId: z.string().min(1),
    jobs: z
      .array(
        z.object({
          jobId: z.string().min(1),
          poseLabel: z.string().min(1),
          prompt: z.string().optional(),
          modelId: z.string().optional(),
          referenceImageUrl: z.string().url().optional(),
        })
      )
      .min(1)
      .max(16),
  });

  app.post("/v1/generations/poses", async (req, reply) => {
    const parsed = posesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
    }
    for (const j of parsed.data.jobs) {
      await publishJob("job.pose", {
        ...j,
        batchId: parsed.data.batchId,
        collectionId: parsed.data.collectionId,
        styleId: parsed.data.styleId,
        type: "POSE",
        attempt: 0,
      });
    }
    return reply.send({ ok: true, queued: parsed.data.jobs.length, batchId: parsed.data.batchId });
  });

  app.get("/v1/generations/stream/:batchId", async (req, reply) => {
    const { batchId } = req.params as { batchId: string };
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ batchId, ts: Date.now() })}\n\n`);
    }, 5000);
    req.raw.on("close", () => clearInterval(heartbeat));
  });
}
