export type QualityResult = {
  status: "PASS" | "REVIEW" | "FAILED";
  checks: {
    hasOutputUrl: boolean;
    dimensionsOk: boolean;
    aspectRatioOk: boolean;
  };
};

function parseAspectRatio(aspectRatio?: string) {
  if (!aspectRatio || !aspectRatio.includes(":")) return null;
  const [w, h] = aspectRatio.split(":").map((v) => Number(v));
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return null;
  return w / h;
}

export function runMvpQualityChecks(input: {
  outputImageUrl?: string;
  width?: number | null;
  height?: number | null;
  requestedAspectRatio?: string;
  minWidth?: number;
  minHeight?: number;
}): QualityResult {
  const hasOutputUrl = Boolean(input.outputImageUrl);
  const minWidth = input.minWidth ?? 512;
  const minHeight = input.minHeight ?? 512;
  const dimensionsOk = Boolean(
    (input.width ?? 0) >= minWidth && (input.height ?? 0) >= minHeight
  );

  const requested = parseAspectRatio(input.requestedAspectRatio);
  const actual =
    (input.width ?? 0) > 0 && (input.height ?? 0) > 0
      ? (input.width as number) / (input.height as number)
      : null;
  const aspectRatioOk =
    requested == null || actual == null ? true : Math.abs(requested - actual) <= 0.08;

  if (!hasOutputUrl) {
    return { status: "FAILED", checks: { hasOutputUrl, dimensionsOk, aspectRatioOk } };
  }
  if (hasOutputUrl && dimensionsOk && aspectRatioOk) {
    return { status: "PASS", checks: { hasOutputUrl, dimensionsOk, aspectRatioOk } };
  }
  return { status: "REVIEW", checks: { hasOutputUrl, dimensionsOk, aspectRatioOk } };
}
