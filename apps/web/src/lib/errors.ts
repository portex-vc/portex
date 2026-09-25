import messages from "../../messages/en.json";

function extractErrorName(err: unknown): string | null {
  // viem's BaseError chain carries `errorName` on ContractFunctionRevertedError.
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const anyCur = cur as Record<string, unknown>;
    if (typeof anyCur.errorName === "string" && anyCur.errorName) return anyCur.errorName;
    if (Array.isArray(anyCur.metaMessages)) {
      for (const m of anyCur.metaMessages) {
        if (typeof m === "string") {
          const match = m.match(/Error:\s*([A-Za-z0-9_]+)/);
          if (match) return match[1];
        }
      }
    }
    if (anyCur.data && typeof anyCur.data === "object" && "errorName" in anyCur.data)
      return String(anyCur.data.errorName);
    cur = anyCur.cause;
  }
  const text = String(err instanceof Error ? err.message : err);
  const match =
    text.match(/\b([A-Z][A-Za-z0-9]+)\(\)/) ?? text.match(/reverted with custom error .*?([A-Z][A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

/** Stable plain-language errors, translated at the presentation boundary. */
export function humanizeError(
  err: unknown,
  translate?: (key: string, values?: Record<string, string | number>) => string,
): string {
  const message = (key: string) => (translate ? translate(key) : messages.errors[key as keyof typeof messages.errors]);
  const apiCode = err && typeof err === "object" && "code" in err ? String(err.code) : null;
  if (
    apiCode === "RATE_LIMITED" &&
    err &&
    typeof err === "object" &&
    "retryAfterSeconds" in err &&
    Number(err.retryAfterSeconds) > 0 &&
    translate
  )
    return translate("rateLimitMinutes", { minutes: Math.ceil(Number(err.retryAfterSeconds) / 60) });
  if (apiCode && apiCode in messages.errors) return message(apiCode);
  const status = err && typeof err === "object" && "status" in err ? Number(err.status) : 0;
  if (status === 401) return message("BAD_SIGNATURE");
  if (status === 403) return message("NOT_BUILDER");
  if (status === 429) return message("RATE_LIMITED");
  const name = extractErrorName(err);
  if (name && name in messages.errors) return message(name);
  const text = String(err instanceof Error ? err.message : err);
  if (/user rejected|denied/i.test(text)) return message("rejected");
  if (/insufficient funds/i.test(text)) return message("gas");
  if (/HTTP request failed|fetch failed|Failed to fetch|network/i.test(text)) return message("network");
  if (/allowance|ERC20: insufficient/i.test(text)) return message("allowance");
  if (/reverted/i.test(text)) return message("reverted");
  return message("unknown");
}
