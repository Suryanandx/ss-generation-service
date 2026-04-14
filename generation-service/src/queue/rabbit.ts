import amqp, { type Channel, type ChannelModel } from "amqplib";
import { config } from "../config.js";
import { ensureQueueTopology } from "./topology.js";
import type { AppEvent, QueueJobPayload } from "../types.js";

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function getRabbitChannel() {
  if (channel) return channel;
  connection = await amqp.connect(config.rabbitUrl);
  const nextChannel = await connection.createChannel();
  await ensureQueueTopology(nextChannel);
  channel = nextChannel;
  return nextChannel;
}

export async function publishJob(routingKey: "job.base" | "job.pose", payload: QueueJobPayload) {
  const ch = await getRabbitChannel();
  ch.publish(config.queueExchange, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: "application/json",
    messageId: payload.jobId,
  });
}

export async function publishEvent(event: AppEvent) {
  const ch = await getRabbitChannel();
  ch.publish(config.eventsExchange, event.type, Buffer.from(JSON.stringify(event)), {
    persistent: false,
    contentType: "application/json",
  });
}
