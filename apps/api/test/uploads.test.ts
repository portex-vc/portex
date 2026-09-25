import { afterAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, ANVIL_ACCOUNTS } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { signRequest } from '../src/lib/signed-request.ts';
import { RateLimiter } from '../src/lib/rate-limit.ts';
import { createV31App } from '../src/v31/api.ts';
import {
  createUploadsApp,
  sniffImageType,
  validateImageRef,
  resolveImageUrl,
  storedProfileImage,
  gatewayOrigin,
  UPLOAD_MAX_BYTES,
  PINATA_UPLOAD_URL,
  type UploadsOptions,
} from '../src/v31/uploads.ts';

const builder = privateKeyToAccount(ANVIL_ACCOUNTS[3].privateKey as `0x${string}`);
const stranger = privateKeyToAccount(ANVIL_ACCOUNTS[4].privateKey as `0x${string}`);
const API = 'http://api.test';
const JWT = 'test-jwt-never-logged';
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function config(extra: Record<string, string> = {}) {
  return loadConfig({ PORTEX_CHAIN_ID: '31337', PUBLIC_API_URL: API, DATABASE_PATH: ':memory:', ...extra });
}
function stack(opts: Partial<UploadsOptions> & { env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'portex-uploads-test-'));
  dirs.push(dir);
  const logs: string[] = [];
  const app = new Hono().route(
    '/v2/uploads',
    createUploadsApp({ config: config(opts.env), dir, log: (m) => logs.push(m), ...opts }),
  );
  return { app, dir, logs };
}
async function upload(app: Hono, value: unknown, signer = builder, override: Record<string, string> = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const headers = await signRequest(signer, 'POST', '/v2/uploads', body);
  return app.request(`${API}/v2/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...override },
    body,
  });
}

describe('image helpers', () => {
  test('magic bytes decide the type', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  test('profile image references are ipfs, https or own uploads, at most 500 chars', () => {
    const c = config();
    const own = `${API}/v2/uploads/${'a'.repeat(64)}.png`;
    expect(validateImageRef(`ipfs://${CID}`, c)).toEqual({ ok: true, image: `ipfs://${CID}` });
    expect(validateImageRef('https://cdn.example/logo.png', c)).toEqual({
      ok: true,
      image: 'https://cdn.example/logo.png',
    });
    expect(validateImageRef(own, c)).toEqual({ ok: true, image: own });
    expect(validateImageRef(null, c)).toEqual({ ok: true, image: null });
    expect(validateImageRef('', c)).toEqual({ ok: true, image: null });
    for (const bad of [
      'http://cdn.example/logo.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'ipfs://short',
      `${API}/v2/uploads/../../etc/passwd`,
      `http://other.test/v2/uploads/${'a'.repeat(64)}.png`,
      `https://x.example/${'a'.repeat(500)}`,
      'https://a.example/x y',
      42,
    ]) {
      expect(validateImageRef(bad, c).ok).toBe(false);
    }
  });

  test('imageUrl applies the gateway to ipfs:// and keeps https', () => {
    const c = config();
    expect(resolveImageUrl(`ipfs://${CID}`, c)).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
    expect(resolveImageUrl(`ipfs://${CID}`, config({ PINATA_GATEWAY: 'portex.mypinata.cloud/' }))).toBe(
      `https://portex.mypinata.cloud/ipfs/${CID}`,
    );
    expect(resolveImageUrl('https://cdn.example/logo.png', c)).toBe('https://cdn.example/logo.png');
    expect(resolveImageUrl(`/v2/uploads/${'b'.repeat(64)}.webp`, c)).toBe(`${API}/v2/uploads/${'b'.repeat(64)}.webp`);
    expect(resolveImageUrl('http://evil.example/x.png', c)).toBeNull();
    expect(resolveImageUrl(null, c)).toBeNull();
    expect(gatewayOrigin({ pinataGateway: 'https://gw.example/ipfs/' })).toBe('https://gw.example');
    expect(storedProfileImage(JSON.stringify({ tagline: 't', image: `ipfs://${CID}` }), c)).toEqual({
      image: `ipfs://${CID}`,
      imageUrl: `https://gateway.pinata.cloud/ipfs/${CID}`,
    });
    expect(storedProfileImage('{"tagline":"t"}', c)).toEqual({ image: null, imageUrl: null });
    expect(storedProfileImage('not json', c)).toEqual({ image: null, imageUrl: null });
  });
});

describe('POST /v2/uploads (local storage)', () => {
  test('stores a signed PNG and serves it immutably', async () => {
    const { app, dir } = stack();
    const res = await upload(app, { contentType: 'image/png', data: b64(PNG) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.cid).toBeNull();
    expect(body.contentType).toBe('image/png');
    expect(body.bytes).toBe(PNG.length);
    expect(body.uri).toBe(body.url);
    expect(body.url).toMatch(new RegExp(`^${API}/v2/uploads/[0-9a-f]{64}\\.png$`));
    const file = body.url.split('/').pop();
    expect(existsSync(join(dir, file))).toBe(true);
    const get = await app.request(body.url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);
    // Same bytes, same content address.
    const again = (await (await upload(app, { contentType: 'image/png', data: b64(PNG) })).json()) as any;
    expect(again.url).toBe(body.url);
  });

  test('accepts JPEG and WebP with their own extensions', async () => {
    const { app } = stack();
    const jpeg = (await (await upload(app, { contentType: 'image/jpeg', data: b64(JPEG) })).json()) as any;
    const webp = (await (await upload(app, { contentType: 'image/webp', data: b64(WEBP) })).json()) as any;
    expect(jpeg.url).toEndWith('.jpg');
    expect(webp.url).toEndWith('.webp');
    expect((await app.request(jpeg.url)).headers.get('content-type')).toBe('image/jpeg');
    expect((await app.request(webp.url)).headers.get('content-type')).toBe('image/webp');
  });

  test('rejects unsigned, tampered and stale requests', async () => {
    const { app } = stack();
    const body = JSON.stringify({ contentType: 'image/png', data: b64(PNG) });
    expect((await app.request(`${API}/v2/uploads`, { method: 'POST', body })).status).toBe(400);
    const headers = await signRequest(builder, 'POST', '/v2/uploads', body);
    const tampered = await app.request(`${API}/v2/uploads`, {
      method: 'POST',
      headers,
      body: body.replace('png', 'jpeg'),
    });
    expect(tampered.status).toBe(401);
    const stale = await signRequest(builder, 'POST', '/v2/uploads', body, Math.floor(Date.now() / 1000) - 3600);
    const res = await app.request(`${API}/v2/uploads`, { method: 'POST', headers: stale, body });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe('STALE_TIMESTAMP');
  });

  test('validates type by magic bytes, base64 and size', async () => {
    const { app } = stack();
    const mismatch = await upload(app, { contentType: 'image/png', data: b64(JPEG) });
    expect(mismatch.status).toBe(415);
    expect(((await mismatch.json()) as any).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(
      (await upload(app, { contentType: 'image/svg+xml', data: b64(new TextEncoder().encode('<svg/>')) })).status,
    ).toBe(415);
    expect(
      (await upload(app, { contentType: 'image/png', data: b64(new TextEncoder().encode('<svg/>')) })).status,
    ).toBe(415);
    expect((await upload(app, { contentType: 'image/png', data: 'not base64!' })).status).toBe(400);
    expect((await upload(app, { contentType: 'image/png' })).status).toBe(400);
    expect((await upload(app, '[1,2]')).status).toBe(400);
    const big = new Uint8Array(UPLOAD_MAX_BYTES + 1);
    big.set(PNG);
    const tooBig = await upload(app, { contentType: 'image/png', data: b64(big) });
    expect(tooBig.status).toBe(413);
    const exact = new Uint8Array(UPLOAD_MAX_BYTES);
    exact.set(PNG);
    expect((await upload(app, { contentType: 'image/png', data: b64(exact) })).status).toBe(201);
  });

  test('rate-limits per signing address', async () => {
    const { app } = stack({ limiter: new RateLimiter(2, 60_000) });
    const payload = { contentType: 'image/png', data: b64(PNG) };
    expect((await upload(app, payload)).status).toBe(201);
    expect((await upload(app, payload)).status).toBe(201);
    const limited = await upload(app, payload);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await upload(app, payload, stranger)).status).toBe(201);
  });

  test('serves only content-addressed names', async () => {
    const { app } = stack();
    expect((await app.request(`${API}/v2/uploads/${'c'.repeat(64)}.png`)).status).toBe(404);
    expect((await app.request(`${API}/v2/uploads/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await app.request(`${API}/v2/uploads/x.svg`)).status).toBe(404);
  });
});

describe('POST /v2/uploads (Pinata)', () => {
  test('pins through the v3 Files API with the server JWT', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: { id: 'f1', cid: CID, size: PNG.length, mime_type: 'image/png' } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const { app, dir } = stack({
      fetch: fakeFetch,
      env: { PINATA_JWT: JWT, PINATA_GATEWAY: 'https://portex.mypinata.cloud' },
    });
    const res = await upload(app, { contentType: 'image/png', data: b64(PNG) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      uri: `ipfs://${CID}`,
      url: `https://portex.mypinata.cloud/ipfs/${CID}`,
      cid: CID,
      contentType: 'image/png',
      bytes: PNG.length,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PINATA_UPLOAD_URL);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`);
    const form = calls[0].init.body as FormData;
    expect(form.get('network')).toBe('public');
    const file = form.get('file') as File;
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    expect(existsSync(join(dir, `${file.name}`))).toBe(false);
  });

  test('defaults to the public Pinata gateway', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ data: { cid: CID } }))) as unknown as typeof fetch;
    const { app } = stack({ fetch: fakeFetch, env: { PINATA_JWT: JWT } });
    const body = (await (await upload(app, { contentType: 'image/png', data: b64(PNG) })).json()) as any;
    expect(body.url).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
  });

  test('falls back to local storage when Pinata fails, without logging the JWT', async () => {
    for (const fakeFetch of [
      async () => new Response('{"error":"unauthorized"}', { status: 401 }),
      async () => new Response('{"data":{}}', { status: 200 }),
      async () => {
        throw new TypeError('network down');
      },
    ]) {
      const { app, logs } = stack({ fetch: fakeFetch as unknown as typeof fetch, env: { PINATA_JWT: JWT } });
      const res = await upload(app, { contentType: 'image/png', data: b64(PNG) });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.cid).toBeNull();
      expect(body.url).toStartWith(`${API}/v2/uploads/`);
      expect((await app.request(body.url)).status).toBe(200);
      expect(logs.length).toBe(1);
      expect(logs.join('\n')).not.toContain(JWT);
    }
  });
});

describe('PUT /v2/raises/:address/profile image', () => {
  const raise = '0x1111111111111111111111111111111111111111';
  function v2() {
    const db = openDb(':memory:');
    const app = new Hono().route(
      '/v2',
      createV31App({ config: config(), db, clients: {} as never, indexer: {} as never, analyst: {} as never }),
    );
    db.query(
      `INSERT INTO v31_raises (address,builder,templateId,version,token,governor,vesting,claims,adapter,createdAt,blockNumber,txHash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(raise, builder.address, '0x00', 1, raise, raise, raise, raise, raise, 1, 1, '0x00');
    return { app, db };
  }
  async function put(app: Hono, value: unknown, signer = builder) {
    const path = `/v2/raises/${raise}/profile`;
    const body = JSON.stringify(value);
    return app.request(`${API}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await signRequest(signer, 'PUT', path, body)) },
      body,
    });
  }
  const base = {
    tagline: 'Agents for audits',
    description: 'A description.',
    website: '',
    twitter: '',
    github: '',
    docs: '',
  };
  const stored = (db: ReturnType<typeof openDb>) =>
    JSON.parse((db.query('SELECT profile FROM v31_profiles').get() as { profile: string }).profile);

  test('stores, keeps, resolves and clears the image', async () => {
    const { app, db } = v2();
    const set = await put(app, { ...base, image: `ipfs://${CID}` });
    expect(set.status).toBe(200);
    const body = (await set.json()) as any;
    expect(body.profile.image).toBe(`ipfs://${CID}`);
    expect(body.profile.imageUrl).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
    expect(stored(db).image).toBe(`ipfs://${CID}`);
    // Absent keeps the stored image; the other fields still replace.
    const keep = (await (await put(app, { ...base, tagline: 'Renamed' })).json()) as any;
    expect(keep.profile.image).toBe(`ipfs://${CID}`);
    expect(stored(db)).toMatchObject({ tagline: 'Renamed', image: `ipfs://${CID}` });
    const own = `${API}/v2/uploads/${'d'.repeat(64)}.png`;
    expect(((await (await put(app, { ...base, image: own })).json()) as any).profile.imageUrl).toBe(own);
    const cleared = (await (await put(app, { ...base, image: null })).json()) as any;
    expect(cleared.profile).toMatchObject({ image: null, imageUrl: null });
    expect(stored(db).image).toBeUndefined();
  });

  test('rejects invalid images and non-builders', async () => {
    const { app, db } = v2();
    for (const image of [
      'http://cdn.example/a.png',
      'javascript:alert(1)',
      `https://x.example/${'a'.repeat(500)}`,
      7,
    ]) {
      const res = await put(app, { ...base, image });
      expect(res.status).toBe(400);
    }
    expect((await put(app, { ...base, image: `ipfs://${CID}` }, stranger)).status).toBe(403);
    expect(db.query('SELECT COUNT(*) AS n FROM v31_profiles').get()).toEqual({ n: 0 });
  });
});
