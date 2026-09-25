import { getAddress, sha256, stringToBytes, type Address, type Hex } from "viem";

/** sha256 of the raw request body, rendered as 0x-prefixed lowercase hex. */
function hashRequestBody(body: string | Uint8Array): Hex {
  return sha256(typeof body === "string" ? stringToBytes(body) : body);
}

/** The exact EIP-191 message the signer must sign. */
export function signedRequestMessage(
  method: string,
  path: string,
  ts: number | string,
  body: string | Uint8Array,
): string {
  return `Portex request\n${method.toUpperCase()} ${path}\nts: ${ts}\nbody: ${hashRequestBody(body)}`;
}

export interface RequestSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
}

/** Sign the exact serialized body, using wall time rather than the chain clock. */
export async function signedRequestHeaders(
  signer: RequestSigner,
  method: string,
  path: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
): Promise<{ "X-Portex-Address": string; "X-Portex-Signature": Hex; "X-Portex-Ts": string }> {
  const signature = await signer.signMessage({ message: signedRequestMessage(method, path, ts, body) });
  return {
    "X-Portex-Address": getAddress(signer.address),
    "X-Portex-Signature": signature,
    "X-Portex-Ts": String(ts),
  };
}
