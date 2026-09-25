/** Project image rules shared by the upload control and its tests (mirrors POST /v2/uploads). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");

export type ImageFileProblem = "type" | "size" | "empty";

/** Client-side check before reading the file; the server re-checks the type by magic bytes. */
export function checkImageFile(file: { type: string; size: number }): ImageFileProblem | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return "type";
  if (file.size === 0) return "empty";
  if (file.size > IMAGE_MAX_BYTES) return "size";
  return null;
}

/** The base64 payload of a data URL ("data:image/png;base64,AAAA" → "AAAA"). */
export function dataUrlPayload(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

/** Upload failures the control explains in its own words; anything else goes through humanizeError. */
export function uploadFailure(error: unknown): "unavailable" | "offline" | "tooLarge" | "rejected" | null {
  if (!error || typeof error !== "object") return null;
  const status = "status" in error ? Number(error.status) : NaN;
  const code = "code" in error ? String(error.code) : "";
  if (code === "unreachable" || status === 0) return "offline";
  if (status === 404 || status === 405 || status === 501) return "unavailable";
  if (status === 413) return "tooLarge";
  if (status === 400 || status === 415 || status === 422) return "rejected";
  return null;
}
