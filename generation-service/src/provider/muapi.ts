const BASE_URL = process.env.MUAPI_BASE_URL || "https://api.muapi.ai";

export type MuapiRequest = {
  endpoint: string;
  payload: Record<string, unknown>;
  apiKey: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitAndPollMuapi(req: MuapiRequest) {
  const submitRes = await fetch(`${BASE_URL}/api/v1/${req.endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": req.apiKey },
    body: JSON.stringify(req.payload),
  });
  if (!submitRes.ok) {
    throw new Error(`Muapi submit failed (${submitRes.status})`);
  }
  const submitData = (await submitRes.json()) as Record<string, unknown>;
  const requestId = String(submitData.request_id || submitData.id || "");
  if (!requestId) return submitData;

  const maxAttempts = req.maxAttempts ?? 240;
  const interval = req.pollIntervalMs ?? 2_000;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval);
    const pollRes = await fetch(`${BASE_URL}/api/v1/predictions/${requestId}/result`, {
      headers: { "x-api-key": req.apiKey },
    });
    if (!pollRes.ok) continue;
    const data = (await pollRes.json()) as Record<string, unknown>;
    const status = String(data.status || "").toLowerCase();
    if (status === "completed" || status === "success" || status === "succeeded") return data;
    if (status === "failed" || status === "error") {
      throw new Error(String(data.error || "Muapi generation failed"));
    }
  }
  throw new Error("Muapi generation timed out");
}
