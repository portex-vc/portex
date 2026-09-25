import { describe, test, expect } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  signedRequestMessage, verifySignedRequest, signRequest, hashRequestBody,
  SIGNED_REQUEST_MAX_AGE_S,
} from '../src/lib/signed-request.ts';
import { ANVIL_ACCOUNTS } from '../src/config.ts';

const signer = privateKeyToAccount(ANVIL_ACCOUNTS[3].privateKey as `0x${string}`);
const other = privateKeyToAccount(ANVIL_ACCOUNTS[4].privateKey as `0x${string}`);

const METHOD = 'POST';
const PATH = '/v1/raises/0x1234567890abcdef1234567890ABCDEF12345678/analyze';
const BODY = '{}';
const NOW = 1_800_000_000;

async function signed(ts = NOW, body = BODY, key = signer, path = PATH) {
  const message = signedRequestMessage(METHOD, path, ts, body);
  return key.signMessage({ message });
}

describe('signed-request verifier', () => {
  test('valid request verifies and returns the checksummed address', async () => {
    const res = await verifySignedRequest({
      address: signer.address, signature: await signed(), ts: NOW,
      method: METHOD, path: PATH, body: BODY, now: NOW,
    });
    expect(res).toEqual({ ok: true, address: signer.address });
  });

  test('signRequest headers round-trip through the verifier', async () => {
    const headers = await signRequest(signer, METHOD, PATH, BODY, NOW);
    const res = await verifySignedRequest({
      address: headers['X-Portex-Address'], signature: headers['X-Portex-Signature'],
      ts: headers['X-Portex-Ts'], method: METHOD, path: PATH, body: BODY, now: NOW,
    });
    expect(res.ok).toBe(true);
  });

  test('stale timestamp rejected (> 5 minutes old)', async () => {
    const ts = NOW - SIGNED_REQUEST_MAX_AGE_S - 1;
    const res = await verifySignedRequest({
      address: signer.address, signature: await signed(ts), ts,
      method: METHOD, path: PATH, body: BODY, now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('STALE_TIMESTAMP');
  });

  test('timestamp exactly at the age limit still passes', async () => {
    const ts = NOW - SIGNED_REQUEST_MAX_AGE_S;
    const res = await verifySignedRequest({
      address: signer.address, signature: await signed(ts), ts,
      method: METHOD, path: PATH, body: BODY, now: NOW,
    });
    expect(res.ok).toBe(true);
  });

  test('future timestamp rejected', async () => {
    const ts = NOW + 120;
    const res = await verifySignedRequest({
      address: signer.address, signature: await signed(ts), ts,
      method: METHOD, path: PATH, body: BODY, now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FUTURE_TIMESTAMP');
  });

  test('wrong signer rejected', async () => {
    const res = await verifySignedRequest({
      address: other.address, signature: await signed(), ts: NOW,
      method: METHOD, path: PATH, body: BODY, now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BAD_SIGNATURE');
  });

  test('tampered body rejected', async () => {
    const res = await verifySignedRequest({
      address: signer.address, signature: await signed(), ts: NOW,
      method: METHOD, path: PATH, body: '{"forged":true}', now: NOW,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('BAD_SIGNATURE');
  });

  test('tampered path rejected', async () => {
    const res = await verifySignedRequest({
      address: signer.address, signature: await signed(), ts: NOW,
      method: METHOD, path: '/v1/raises/0x9999999999999999999999999999999999999999/analyze', body: BODY, now: NOW,
    });
    expect(res.ok).toBe(false);
  });

  test('missing/invalid headers rejected with 400', async () => {
    for (const args of [
      { address: null, signature: await signed(), ts: NOW },
      { address: signer.address, signature: null, ts: NOW },
      { address: signer.address, signature: await signed(), ts: null },
      { address: signer.address, signature: '0xdeadbeef', ts: NOW },
      { address: signer.address, signature: await signed(), ts: 'tomorrow' },
    ]) {
      const res = await verifySignedRequest({ ...args, method: METHOD, path: PATH, body: BODY, now: NOW });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(400);
    }
  });

  test('the message format is exactly as documented', () => {
    expect(signedRequestMessage('post', PATH, NOW, BODY)).toBe(
      `Portex request\nPOST ${PATH}\nts: ${NOW}\nbody: ${hashRequestBody(BODY)}`,
    );
    expect(hashRequestBody(BODY)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
