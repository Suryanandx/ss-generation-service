import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4040),
  host: process.env.HOST || "0.0.0.0",
  serviceToken: process.env.GEN_SERVICE_TOKEN || "",
  rabbitUrl: process.env.RABBITMQ_URL || "amqp://localhost:5672",
  queueExchange: "image.gen.direct",
  retryExchange: "image.gen.retry",
  eventsExchange: "image.gen.events",
  baseQueue: "image.base.q",
  poseQueue: "image.pose.q",
  retryQueue: "image.retry.q",
  dlqQueue: "image.dlq",
  databaseUrl:
    process.env.GEN_DATABASE_URL ||
    process.env.KPOP_PRISMA_DATABASE_URL ||
    "",
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || "http://127.0.0.1:3001",
  workerToken: process.env.GEN_WORKER_TOKEN || "",
  recoverySweepMinMs: Math.max(5000, Number(process.env.RECOVERY_SWEEP_MIN_MS || 15000)),
  recoverySweepMaxMs: Math.max(30000, Number(process.env.RECOVERY_SWEEP_MAX_MS || 300000)),
  recoverySweepIdleGuardMs: Math.max(5000, Number(process.env.RECOVERY_SWEEP_IDLE_GUARD_MS || 30000)),
};
