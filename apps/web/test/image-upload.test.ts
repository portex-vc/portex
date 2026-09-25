import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ApiError, api, profileBody, type BuilderProfile } from "../src/lib/api";
import { checkImageFile, dataUrlPayload, IMAGE_MAX_BYTES, uploadFailure } from "../src/lib/image-upload";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("project images accept PNG, JPEG and WebP up to 2 MB", () => {
  expect(checkImageFile({ type: "image/png", size: 1024 })).toBeNull();
  expect(checkImageFile({ type: "image/jpeg", size: IMAGE_MAX_BYTES })).toBeNull();
  expect(checkImageFile({ type: "image/webp", size: 10 })).toBeNull();
  expect(checkImageFile({ type: "image/webp", size: IMAGE_MAX_BYTES + 1 })).toBe("size");
  expect(checkImageFile({ type: "image/gif", size: 10 })).toBe("type");
  expect(checkImageFile({ type: "image/svg+xml", size: 10 })).toBe("type");
  expect(checkImageFile({ type: "image/png", size: 0 })).toBe("empty");
  expect(dataUrlPayload("data:image/png;base64,QUJD")).toBe("QUJD");
  expect(dataUrlPayload("garbage")).toBe("");
});

test("a missing or unreachable upload endpoint is classified, not shown raw", () => {
  expect(uploadFailure(new ApiError("http_error", "HTTP 404", 404))).toBe("unavailable");
  expect(uploadFailure(new ApiError("unreachable", "down", 0))).toBe("offline");
  expect(uploadFailure(new ApiError("PAYLOAD_TOO_LARGE", "big", 413))).toBe("tooLarge");
  expect(uploadFailure(new ApiError("BAD_REQUEST", "magic bytes", 400))).toBe("rejected");
  expect(uploadFailure(new ApiError("BAD_SIGNATURE", "sig", 401))).toBeNull();
});

test("the profile body carries only accepted fields, and the image only when it changed", () => {
  const profile: BuilderProfile = {
    name: null,
    tagline: "t",
    description: "d",
    website: "",
    twitter: "@x",
    github: "",
    docs: "",
    logoUrl: null,
    image: "ipfs://old",
    imageUrl: "https://gateway/ipfs/old",
  };
  expect(Object.keys(profileBody(profile)).sort()).toEqual(
    ["description", "docs", "github", "logoUrl", "name", "tagline", "twitter", "website"].sort(),
  );
  expect(profileBody(profile, "ipfs://new").image).toBe("ipfs://new");
  expect(profileBody(profile, null)).toHaveProperty("image", null);
});

test("uploads are signed over the exact JSON body sent", async () => {
  const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
  let seen = "";
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const hash = createHash("sha256").update(body).digest("hex");
      expect(
        await verifyMessage({
          address: account.address,
          signature: headers.get("X-Portex-Signature") as `0x${string}`,
          message: `Portex request\n${init?.method} ${path}\nts: ${headers.get("X-Portex-Ts")}\nbody: 0x${hash}`,
        }),
      ).toBe(true);
      seen = `${init?.method} ${path} ${JSON.parse(body).contentType}`;
      return Response.json(
        { uri: "ipfs://cid", url: "https://gw/ipfs/cid", cid: "cid", contentType: "image/png", bytes: 3 },
        { status: 201 },
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const result = await api.upload({ contentType: "image/png", data: "QUJD" }, account);
  expect(seen).toBe("POST /v2/uploads image/png");
  expect(result.uri).toBe("ipfs://cid");
});
