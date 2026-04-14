import type { Channel } from "amqplib";
import { config } from "../config.js";

export async function ensureQueueTopology(channel: Channel) {
  await channel.assertExchange(config.queueExchange, "direct", { durable: true });
  await channel.assertExchange(config.retryExchange, "direct", { durable: true });
  await channel.assertExchange(config.eventsExchange, "topic", { durable: true });

  await channel.assertQueue(config.dlqQueue, { durable: true });
  await channel.assertQueue(config.baseQueue, {
    durable: true,
    deadLetterExchange: config.retryExchange,
    deadLetterRoutingKey: "job.retry",
  });
  await channel.assertQueue(config.poseQueue, {
    durable: true,
    deadLetterExchange: config.retryExchange,
    deadLetterRoutingKey: "job.retry",
  });
  await channel.assertQueue(config.retryQueue, {
    durable: true,
    deadLetterExchange: config.queueExchange,
    deadLetterRoutingKey: "job.base",
    messageTtl: 30_000,
  });

  await channel.bindQueue(config.baseQueue, config.queueExchange, "job.base");
  await channel.bindQueue(config.poseQueue, config.queueExchange, "job.pose");
  await channel.bindQueue(config.retryQueue, config.retryExchange, "job.retry");
  await channel.bindQueue(config.dlqQueue, config.retryExchange, "job.failed");
}
