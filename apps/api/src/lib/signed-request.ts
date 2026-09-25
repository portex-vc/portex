/**
 * Portex signed-request scheme (EIP-191) for privileged or costly write endpoints.
 * This file is deliberately self-contained and dependency-light (only `viem`) so the
 * frontend can copy it verbatim.
 *
 * The caller signs an EIP-191 `personal_sign` message binding the request:
 *
 *   Portex request
 *   <METHOD> <path>
 *   ts: <unix seconds>
 *   body: <sha256 of the raw body, 0x-prefixed lowercase hex>
 *
 * and sends three headers:
 *
 *   X-Portex-Address:   the signing EOA (checksummed or lowercase)
 *   X-Portex-Signature: 0x-prefixed 65-byte personal_sign signature over the message
 *   X-Portex-Ts:        unix seconds when the signature was made
 *
 * The server rejects requests whose timestamp is older than MAX_AGE_S (5 minutes) or
 * further than MAX_SKEW_S (60s) in the future, and requests whose signature does not
 * recover to the claimed address. `path` is the URL pathname exactly as the server sees
 * it (e.g. `/v1/raises/0xabc…/analyze`); `METHOD` is uppercase.
 */
import {
  getAddress, sha256, stringToBytes, verifyMessage, isAddress,
  type Address, type Hex,
} from 'viem';

export const SIGNED_REQUEST_MAX_AGE_S = 300;
export const SIGNED_REQUEST_MAX_SKEW_S = 60;

/** sha256 of the raw request body, rendered as 0x-prefixed lowercase hex. */
export function hashRequestBody(body: string | Uint8Array): Hex {
  return sha256(typeof body === 'string' ? stringToBytes(body) : body);
}

/** The exact EIP-191 message the signer must sign. */
export function signedRequestMessage(
  method: string, path: string, ts: number | string, body: string | Uint8Array,
): string {
  return `Portex request\n${method.toUpperCase()} ${path}\nts: ${ts}\nbody: ${hashRequestBody(body)}`;
}

export type SignedRequestResult =
  | { ok: true; address: Address }
  | { ok: false; status: 400 | 401; code: string; message: string };

/**
 * Verify one signed request. `now` is unix seconds (defaults to wall clock) so tests
 * can pin the clock.
 */
export async function verifySignedRequest(args: {
  address?: string | null;
  signature?: string | null;
  ts?: string | number | null;
  method: string;
  path: string;
  body: string | Uint8Array;
  now?: number;
}): Promise<SignedRequestResult> {
  const { method, path, body } = args;
  const now = args.now ?? Math.floor(Date.now() / 1000);

  if (!args.address || !isAddress(args.address)) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'X-Portex-Address must be a valid address' };
  }
  const ts = Number(args.ts);
  if (args.ts === undefined || args.ts === null || !Number.isInteger(ts) || ts <= 0) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'X-Portex-Ts must be a unix-seconds integer' };
  }
  if (!args.signature || !/^0x[0-9a-fA-F]{130}$/.test(args.signature)) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'X-Portex-Signature must be a 0x-prefixed 65-byte signature' };
  }
  if (now - ts > SIGNED_REQUEST_MAX_AGE_S) {
    return { ok: false, status: 401, code: 'STALE_TIMESTAMP', message: `signed request is older than ${SIGNED_REQUEST_MAX_AGE_S} seconds — sign again` };
  }
  if (ts - now > SIGNED_REQUEST_MAX_SKEW_S) {
    return { ok: false, status: 401, code: 'FUTURE_TIMESTAMP', message: 'signed request timestamp is too far in the future' };
  }

  const address = getAddress(args.address);
  const message = signedRequestMessage(method, path, ts, body);
  let valid = false;
  try {
    valid = await verifyMessage({ address, message, signature: args.signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 401, code: 'BAD_SIGNATURE', message: 'signature does not recover to X-Portex-Address over the signed-request message' };
  }
  return { ok: true, address };
}

/** Minimal signer shape: a viem `Account` (or anything with address + signMessage). */
export interface MessageSigner {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
}

/**
 * Client side: sign a request and return the headers to send alongside it.
 * `body` must be the exact raw string that will be sent (JSON.stringify output, or '').
 */
export async function signRequest(
  signer: MessageSigner,
  method: string,
  path: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
): Promise<{ 'X-Portex-Address': string; 'X-Portex-Signature': Hex; 'X-Portex-Ts': string }> {
  const signature = await signer.signMessage({ message: signedRequestMessage(method, path, ts, body) });
  return {
    'X-Portex-Address': getAddress(signer.address),
    'X-Portex-Signature': signature,
    'X-Portex-Ts': String(ts),
  };
}
