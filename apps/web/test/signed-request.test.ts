import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { signedRequestHeaders, signedRequestMessage } from "../src/lib/signed-request";

test("signed requests bind the exact method, path, timestamp and raw body", async () => {
  const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000001");
  const path = "/v2/raises/0x0000000000000000000000000000000000000001/analyze";
  const headers = await signedRequestHeaders(account, "POST", path, "{}");
  const timestamp = Number(headers["X-Portex-Ts"]);
  expect(Math.abs(timestamp - Math.floor(Date.now() / 1000))).toBeLessThan(2);
  const valid = (body: string) =>
    verifyMessage({
      address: account.address,
      signature: headers["X-Portex-Signature"],
      message: signedRequestMessage("POST", path, timestamp, body),
    });
  expect(await valid("{}")).toBe(true);
  expect(await valid('{"changed":true}')).toBe(false);
});
