import amqp, { type Channel, type ChannelModel } from "amqplib";
import { config } from "../config.js";
import { ensureQueueTopology } from "./topology.js";
import type { AppEvent, QueueJobPayload } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reset in resetRabbitState
let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let connectingPromise: Promise<Channel> | null = null;

function resetRabbitState() {
  channel = null;
  connection = null;
}

export async function getRabbitChannel() {
  if (channel) return channel;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    const conn = await amqp.connect(config.rabbitUrl);
    conn.on("error", () => {
      // Prevent unhandled 'error' events from crashing the process.
      resetRabbitState();
    });
    conn.on("close", () => {
      resetRabbitState();
    });

    const nextChannel = await conn.createChannel();
    nextChannel.on("error", () => {
      // Channel errors should invalidate current state for lazy reconnect.
      resetRabbitState();
    });
    nextChannel.on("close", () => {
      resetRabbitState();
    });

    await ensureQueueTopology(nextChannel);
    connection = conn;
    channel = nextChannel;
    return nextChannel;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
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
