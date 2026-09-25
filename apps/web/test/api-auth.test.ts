import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { api } from "../src/lib/api";
import { humanizeError } from "../src/lib/errors";
import { ApiError } from "../src/lib/api";
import { signedRequestMessage } from "../src/lib/signed-request";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("all privileged endpoints sign exactly the bytes sent over HTTP", async () => {
  const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
  const seen: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      expect(path.startsWith("/v2/")).toBe(true);
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const method = init?.method ?? "GET";
      const hash = createHash("sha256").update(body).digest("hex");
      const expected = `Portex request\n${method} ${path}\nts: ${headers.get("X-Portex-Ts")}\nbody: 0x${hash}`;
      expect(
        await verifyMessage({
          address: account.address,
          signature: headers.get("X-Portex-Signature") as `0x${string}`,
          message: expected,
        }),
      ).toBe(true);
      expect(headers.get("X-Portex-Address")).toBe(account.address);
      expect(JSON.parse(body)).not.toHaveProperty("signature");
      seen.push(`${method} ${path.split("/").slice(4).join("/")}`);
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  await api.analyze(account.address, account);
  await api.postMetadata(account.address, { description: "建设者 · descripción" }, account);
  await api.saveProfile(
    account.address,
    {
      name: null,
      tagline: "Hello",
      description: "世界",
      website: "",
      twitter: "",
      github: "",
      docs: "",
      logoUrl: null,
    },
    account,
  );
  await api.postUpdate(account.address, { title: "Milestone", body: "Ready", kind: "milestone" }, account);
  await api.respond(account.address, `0x${"01".repeat(32)}`, { text: "Response" }, account);
  expect(seen).toEqual([
    "POST analyze",
    "POST metadata",
    "PUT profile",
    "POST updates",
    `POST reports/0x${"01".repeat(32)}/response`,
  ]);
});

test("authentication binds method, case-sensitive path, wall timestamp and UTF-8 body", () => {
  const body = '{"text":"你好, español"}';
  expect(signedRequestMessage("post", "/v2/CaseSensitive", 123, body)).toBe(
    `Portex request\nPOST /v2/CaseSensitive\nts: 123\nbody: 0x${createHash("sha256").update(body).digest("hex")}`,
  );
  expect(signedRequestMessage("PUT", "/a", 123, body)).not.toBe(signedRequestMessage("POST", "/a", 123, body));
});

test("API auth and permission errors use plain-language explanations", () => {
  expect(humanizeError(new ApiError("BAD_SIGNATURE", "raw", 401))).toContain("Sign the request again");
  expect(humanizeError(new ApiError("NOT_BUILDER", "raw", 403))).toContain("Only the builder");
  expect(humanizeError(new ApiError("RATE_LIMITED", "raw", 429))).toContain("10 minutes");
});
