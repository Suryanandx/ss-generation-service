import type { ConsumeMessage } from "amqplib";
import { config } from "../config.js";
import { getRabbitChannel, publishEvent } from "./rabbit.js";
import type { QueueJobPayload } from "../types.js";

export type WorkerHandler = (job: QueueJobPayload) => Promise<void>;

async function moveToDlq(raw: ConsumeMessage, reason: string) {
  const ch = await getRabbitChannel();
  ch.publish(config.retryExchange, "job.failed", raw.content, {
    persistent: true,
    contentType: "application/json",
    headers: { reason },
  });
}

export async function startQueueWorkers(handler: WorkerHandler) {
  const ch = await getRabbitChannel();
  ch.prefetch(4);

  const onMessage = async (msg: ConsumeMessage | null) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString("utf8")) as QueueJobPayload;
      await publishEvent({ type: "job.updated", batchId: payload.batchId, jobId: payload.jobId });
      await handler(payload);
      ch.ack(msg);
    } catch (error) {
      const retries = Number(msg.properties.headers?.["x-retry-count"] || 0);
      if (retries >= 3) {
        await moveToDlq(msg, error instanceof Error ? error.message : "worker failure");
        ch.ack(msg);
      } else {
        ch.nack(msg, false, false);
      }
    }
  };

  await ch.consume(config.baseQueue, onMessage, { noAck: false });
  await ch.consume(config.poseQueue, onMessage, { noAck: false });
}
