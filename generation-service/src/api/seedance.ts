import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const MUAPI_BASE = (process.env.MUAPI_BASE_URL || "https://api.muapi.ai").replace(/\/+$/, "");
const MUAPI_CDN = "https://cdn.muapi.ai";

function getMuapiKey() {
  return String(process.env.MUAPI_API_KEY || "").trim();
}

/**
 * Upload a base64 data URL or raw image buffer to MuAPI CDN using their
 * pre-signed S3 flow. Returns the public cdn.muapi.ai URL.
 * MuAPI's images_list only accepts public HTTPS URLs (≤2083 chars).
 */
async function uploadImageToMuapiCdn(imageData: string, apiKey: string): Promise<string> {
  // Determine mime type and raw bytes
  let mimeType = "image/png";
  let imageBuffer: Buffer;

  if (imageData.startsWith("data:")) {
    const match = imageData.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error("Invalid data URL format");
    mimeType = match[1];
    imageBuffer = Buffer.from(match[2], "base64");
  } else {
    throw new Error("Expected a base64 data URL for image upload");
  }

  const ext = mimeType.split("/")[1]?.split("+")[0] || "png";
  const filename = `seedance-ref-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;

  // Step 1: get pre-signed S3 upload URL from MuAPI
  const urlRes = await fetch(`${MUAPI_BASE}/app/get_file_upload_url?filename=${encodeURIComponent(filename)}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!urlRes.ok) {
    const txt = await urlRes.text().catch(() => "");
    throw new Error(`MuAPI file URL request failed (${urlRes.status}): ${txt.slice(0, 200)}`);
  }
  const { url, fields } = (await urlRes.json()) as { url: string; fields: Record<string, string> };
  const s3Key = fields.key;

  // Step 2: POST multipart form to S3 with all pre-signed fields + file
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const arrayBuf: ArrayBuffer = imageBuffer.buffer instanceof SharedArrayBuffer
    ? new Uint8Array(imageBuffer).buffer as ArrayBuffer
    : imageBuffer.buffer as ArrayBuffer;
  form.append("file", new Blob([arrayBuf.slice(imageBuffer.byteOffset, imageBuffer.byteOffset + imageBuffer.byteLength)], { type: mimeType }), filename);

  const uploadRes = await fetch(url, { method: "POST", body: form });
  // S3 pre-signed POST returns 204 on success
  if (!uploadRes.ok && uploadRes.status !== 204) {
    const txt = await uploadRes.text().catch(() => "");
    throw new Error(`MuAPI S3 upload failed (${uploadRes.status}): ${txt.slice(0, 200)}`);
  }

  return `${MUAPI_CDN}/${s3Key}`;
}

/**
 * If the URL is a data URL (base64), upload it to MuAPI CDN and return the
 * public HTTPS URL. Otherwise return the URL unchanged.
 */
async function ensurePublicImageUrl(url: string, apiKey: string): Promise<string> {
  if (!url) return url;
  if (url.startsWith("data:")) return uploadImageToMuapiCdn(url, apiKey);
  return url; // already a public URL
}

async function submitToMuapi(endpoint: string, payload: Record<string, unknown>, apiKey: string) {
  const res = await fetch(`${MUAPI_BASE}/api/v1/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MuAPI submit failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function pollMuapi(requestId: string, apiKey: string) {
  const res = await fetch(`${MUAPI_BASE}/api/v1/predictions/${requestId}/result`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`MuAPI poll failed (${res.status})`);
  return res.json() as Promise<Record<string, unknown>>;
}

function extractOutputUrl(data: Record<string, unknown>): string | null {
  // MuAPI returns outputs as an array: outputs[0] is the video URL
  const arr = data.outputs;
  if (Array.isArray(arr) && arr.length > 0 && arr[0]) return String(arr[0]);
  const direct = data.output_url || data.outputUrl || data.url || data.video_url;
  return direct ? String(direct) : null;
}

function muapiStateToInternal(status: string): "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success" || s === "succeeded") return "COMPLETED";
  if (s === "failed" || s === "error") return "FAILED";
  if (s === "running" || s === "processing" || s === "in_progress" || s === "started") return "RUNNING";
  return "QUEUED";
}

const generateSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  modelId: z.string().min(1),
  // Generation type controls what inputs are required
  generationType: z.enum(["t2v", "i2v", "first-last", "extend"]).default("i2v"),
  // Inputs (which are used depends on generationType)
  sourceImageUrl: z.string().optional(),   // i2v + first-last: start frame
  endFrameImageUrl: z.string().optional(), // first-last: end frame
  inputVideoUrl: z.string().optional(),    // extend: source video URL
  // Common settings
  aspectRatio: z.string().default("16:9"),
  resolution: z.string().default("720p"),
  duration: z.number().default(5),
  motionStrength: z.number().min(0).max(1).default(0.7),
  cameraMotion: z.string().default("none"),
  seed: z.number().default(-1),
});

async function buildMuapiPayload(
  d: z.infer<typeof generateSchema>,
  apiKey: string
): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    prompt: d.prompt,
    aspect_ratio: d.aspectRatio,
    duration: d.duration,
  };

  if (d.resolution && d.resolution !== "auto") base.resolution = d.resolution;
  if (d.seed !== -1) base.seed = d.seed;
  if (d.negativePrompt) base.negative_prompt = d.negativePrompt;

  switch (d.generationType) {
    case "t2v":
      break;

    case "i2v": {
      if (d.sourceImageUrl) {
        const publicUrl = await ensurePublicImageUrl(d.sourceImageUrl, apiKey);
        base.images_list = [publicUrl];
      }
      if (d.motionStrength !== 0.7) base.motion_strength = d.motionStrength;
      if (d.cameraMotion && d.cameraMotion !== "none") base.camera_motion = d.cameraMotion;
      break;
    }

    case "first-last": {
      const frames: string[] = [];
      if (d.sourceImageUrl) frames.push(await ensurePublicImageUrl(d.sourceImageUrl, apiKey));
      if (d.endFrameImageUrl) frames.push(await ensurePublicImageUrl(d.endFrameImageUrl, apiKey));
      if (frames.length > 0) base.images_list = frames;
      break;
    }

    case "extend":
      if (d.inputVideoUrl) base.video_url = d.inputVideoUrl;
      break;
  }

  return base;
}

export async function registerSeedanceRoutes(app: FastifyInstance) {
  // Submit a new video generation
  app.post("/v1/seedance/generate", async (req, reply) => {
    const apiKey = getMuapiKey();
    if (!apiKey) return reply.code(500).send({ error: "MUAPI_API_KEY not configured" });

    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
    }

    const d = parsed.data;

    let muapiPayload: Record<string, unknown>;
    try {
      muapiPayload = await buildMuapiPayload(d, apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Image upload failed";
      return reply.code(502).send({ error: `Image upload to MuAPI CDN failed: ${message}` });
    }

    try {
      const result = await submitToMuapi(d.modelId, muapiPayload, apiKey);
      const requestId = String(result.request_id || result.id || "");
      const outputUrl = extractOutputUrl(result);
      const state = muapiStateToInternal(String(result.status || "queued"));

      if (state === "COMPLETED" && outputUrl) {
        return reply.send({ ok: true, requestId, state, outputUrl });
      }
      if (!requestId) {
        return reply.code(502).send({ error: "MuAPI returned no request ID", raw: result });
      }
      return reply.send({ ok: true, requestId, state, outputUrl: outputUrl ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "MuAPI submission failed";
      return reply.code(502).send({ error: message });
    }
  });

  // Single-shot poll: returns current MuAPI status as plain JSON.
  // Use this for client-driven polling and recovery — does not enforce a wall-clock
  // deadline, so a job that runs longer than the SSE window can still be retrieved.
  app.get("/v1/seedance/result/:requestId", async (req, reply) => {
    const apiKey = getMuapiKey();
    if (!apiKey) return reply.code(500).send({ error: "MUAPI_API_KEY not configured" });

    const { requestId } = req.params as { requestId: string };
    if (!requestId) return reply.code(400).send({ error: "requestId required" });

    try {
      const data = await pollMuapi(requestId, apiKey);
      const state = muapiStateToInternal(String(data.status || ""));
      const outputUrl = extractOutputUrl(data);
      const progress = typeof data.progress === "number" ? data.progress : undefined;
      const error = state === "FAILED"
        ? String(data.error || data.message || data.detail || "Generation failed")
        : undefined;
      return reply.send({ state, outputUrl: outputUrl ?? null, progress, error });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Poll error";
      // 502 so the caller can decide whether to retry — never report a transient
      // network blip as FAILED.
      return reply.code(502).send({ state: "POLL_ERROR", error: message });
    }
  });

  // SSE: polls MuAPI every 2s and streams state events until COMPLETED, FAILED,
  // or the connection is closed. The wall-clock cap is generous because some
  // models (Seedance 2 long durations, Veo) can take 10+ minutes; on timeout
  // we close the stream WITHOUT sending FAILED so the caller can re-poll.
  app.get("/v1/seedance/status/:requestId", async (req, reply) => {
    const apiKey = getMuapiKey();
    if (!apiKey) return reply.code(500).send({ error: "MUAPI_API_KEY not configured" });

    const { requestId } = req.params as { requestId: string };
    if (!requestId) return reply.code(400).send({ error: "requestId required" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (data: object) => {
      if (req.raw.destroyed) return;
      try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
    };

    const MAX_ATTEMPTS = 1200; // 40 min at 2s — safely covers Seedance 2 / Veo long runs
    const INTERVAL_MS = 2000;
    const MAX_CONSECUTIVE_ERRORS = 10;
    let consecutiveErrors = 0;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (req.raw.destroyed) break;

      try {
        const data = await pollMuapi(requestId, apiKey);
        consecutiveErrors = 0;

        const state = muapiStateToInternal(String(data.status || ""));
        const outputUrl = extractOutputUrl(data);
        const progress = typeof data.progress === "number" ? data.progress : undefined;

        send({ state, outputUrl, progress });

        if (state === "COMPLETED") break;

        if (state === "FAILED") {
          const errMsg = String(data.error || data.message || data.detail || "Generation failed");
          send({ state: "FAILED", error: errMsg });
          break;
        }
      } catch (err) {
        consecutiveErrors++;
        const errMsg = err instanceof Error ? err.message : "Poll error";
        send({ state: "POLL_ERROR", error: errMsg });
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          // Network errors are transient — close the stream as RUNNING so the
          // caller polls again on the single-shot endpoint instead of giving up.
          send({ state: "RUNNING", note: `transient errors: ${errMsg}` });
          break;
        }
      }

      await new Promise<void>((r) => {
        const t = setTimeout(r, INTERVAL_MS);
        req.raw.once("close", () => { clearTimeout(t); r(); });
      });
    }

    // No FAILED-on-timeout: callers must use /v1/seedance/result/:requestId to
    // recover jobs that exceed the SSE window.
    if (!reply.raw.destroyed) reply.raw.end();
    return reply;
  });
}
