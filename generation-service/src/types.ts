export type GenerationJobType = "BASE" | "POSE";

export type QueueJobPayload = {
  jobId: string;
  batchId: string;
  collectionId: string;
  styleId: string;
  type: GenerationJobType;
  attempt: number;
  prompt?: string;
  modelId?: string;
  referenceImageUrl?: string;
  poseLabel?: string;
};

export type AppEvent =
  | { type: "batch.updated"; batchId: string }
  | { type: "job.updated"; batchId: string; jobId: string }
  | { type: "asset.created"; batchId: string; assetId: string }
  | { type: "batch.completed"; batchId: string }
  | { type: "batch.failed"; batchId: string; error: string };
