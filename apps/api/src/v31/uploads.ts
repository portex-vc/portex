/**
 * Project image uploads (`POST /v2/uploads`, `GET /v2/uploads/:file`) and the profile `image` helpers.
 *
 * Upload body: `{ "contentType": "image/png" | "image/jpeg" | "image/webp", "data": "<base64>" }`, at most
 * 2 MB decoded, signed with the Portex signed-request scheme (see ../lib/signed-request.ts). The type is checked
 * against the file's magic bytes, and every address is rate-limited.
 *
 * With `PINATA_JWT` set (server env only) the file is pinned to public IPFS through Pinata's v3 Files API and the
 * response carries `uri = ipfs://<cid>`. Without it, or if Pinata fails, the file is stored under the API data dir
 * and served by `GET /v2/uploads/<sha256>.<ext>`. The JWT is never logged or returned.
 */
import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { verifySignedRequest } from '../lib/signed-request.ts';
import { RateLimiter } from '../lib/rate-limit.ts';

export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** Base64 of the largest file plus generous room for the JSON envelope. */
const MAX_BODY_CHARS = Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 1024;
export const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
export type UploadType = keyof typeof UPLOAD_TYPES;
const CONTENT_TYPES: Record<string, UploadType> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const DEFAULT_IPFS_GATEWAY = 'https://gateway.pinata.cloud';
export const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
const FILE_RE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;
const CID_RE = /^[A-Za-z0-9]{46,128}$/;
const IPFS_RE = /^ipfs:\/\/[A-Za-z0-9]{46,128}(\/[A-Za-z0-9._~\-/]*)?$/;
const IMAGE_MAX_CHARS = 500;

export interface UploadResult {
  uri: string;
  url: string;
  cid: string | null;
  contentType: UploadType;
  bytes: number;
}

/** The image type named by the file's magic bytes, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): UploadType | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  // RIFF....WEBP
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Gateway origin for ipfs:// images, without a trailing slash (PINATA_GATEWAY may omit the scheme). */
export function gatewayOrigin(config: Pick<Config, 'pinataGateway'>): string {
  const raw = (config.pinataGateway ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/ipfs$/, '');
  if (!raw) return DEFAULT_IPFS_GATEWAY;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Local upload storage: `<dir of DATABASE_PATH>/uploads`, or a temp dir for in-memory databases. */
export function uploadsDir(config: Pick<Config, 'databasePath' | 'chainId'>): string {
  if (!config.databasePath || config.databasePath === ':memory:')
    return join(tmpdir(), `portex-uploads-${config.chainId}`);
  return resolve(dirname(config.databasePath), 'uploads');
}

function ownUploadFile(value: string, config: Pick<Config, 'publicApiUrl'>): string | null {
  const prefix = `${config.publicApiUrl}/v2/uploads/`;
  const file = value.startsWith(prefix)
    ? value.slice(prefix.length)
    : value.startsWith('/v2/uploads/')
      ? value.slice('/v2/uploads/'.length)
      : null;
  return file !== null && FILE_RE.test(file) ? file : null;
}

/**
 * Validate a profile `image`: `ipfs://…`, `https://…`, or this API's own `/v2/uploads/` URL, at most 500 chars.
 * `null` or `''` clears the image.
 */
export function validateImageRef(
  value: unknown,
  config: Pick<Config, 'publicApiUrl'>,
): { ok: true; image: string | null } | { ok: false; message: string } {
  if (value === null || value === '') return { ok: true, image: null };
  if (typeof value !== 'string') return { ok: false, message: 'image must be a string' };
  const image = value.trim();
  if (!image) return { ok: true, image: null };
  if (image.length > IMAGE_MAX_CHARS) return { ok: false, message: `image must be at most ${IMAGE_MAX_CHARS} chars` };
  if (/\s/.test(image)) return { ok: false, message: 'image must be a single URL' };
  if (IPFS_RE.test(image) || ownUploadFile(image, config)) return { ok: true, image };
  if (/^https:\/\//i.test(image)) {
    try {
      if (new URL(image).protocol === 'https:') return { ok: true, image };
    } catch {
      /* fall through */
    }
  }
  return { ok: false, message: "image must be an ipfs://, https:// or this API's /v2/uploads/ URL" };
}

/** Browser-loadable URL for a stored image: the gateway for ipfs://, the API origin for own uploads, else null. */
export function resolveImageUrl(
  image: string | null | undefined,
  config: Pick<Config, 'publicApiUrl' | 'pinataGateway'>,
): string | null {
  if (!image || typeof image !== 'string') return null;
  if (IPFS_RE.test(image)) return `${gatewayOrigin(config)}/ipfs/${image.slice('ipfs://'.length)}`;
  const own = ownUploadFile(image, config);
  if (own) return `${config.publicApiUrl}/v2/uploads/${own}`;
  if (/^https:\/\/\S+$/i.test(image)) return image;
  return null;
}

/** `image` and resolved `imageUrl` from a stored v31_profiles JSON row. */
export function storedProfileImage(
  profileJson: string | null | undefined,
  config: Pick<Config, 'publicApiUrl' | 'pinataGateway'>,
): { image: string | null; imageUrl: string | null } {
  let image: unknown = null;
  try {
    if (profileJson) image = (JSON.parse(profileJson) as { image?: unknown }).image ?? null;
  } catch {
    /* corrupt row */
  }
  if (typeof image !== 'string' || !image) return { image: null, imageUrl: null };
  return { image, imageUrl: resolveImageUrl(image, config) };
}

export interface UploadsOptions {
  config: Config;
  /** Local storage directory; defaults to `uploadsDir(config)`. */
  dir?: string;
  /** Injectable for tests (Pinata mode). */
  fetch?: typeof fetch;
  /** Per-address limiter; defaults to 20 uploads per 10 minutes. */
  limiter?: RateLimiter;
  /** Unix-seconds clock for signed-request verification (tests). */
  now?: () => number;
  log?: (message: string) => void;
}

function fail(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as never);
}

/** Mounted at `/v2/uploads` by the v2 app. */
export function createUploadsApp(opts: UploadsOptions): Hono {
  const { config } = opts;
  const dir = opts.dir ?? uploadsDir(config);
  const doFetch = opts.fetch ?? fetch;
  const limiter = opts.limiter ?? new RateLimiter(20, 600_000);
  const log = opts.log ?? ((message: string) => console.warn(message));
  const app = new Hono();

  function storeLocally(bytes: Uint8Array, name: string) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    if (existsSync(path)) return;
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }

  async function pin(bytes: Uint8Array, type: UploadType, name: string): Promise<string | null> {
    if (!config.pinataJwt) return null;
    try {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      form.append('network', 'public');
      form.append('name', `portex-${name}`);
      const response = await doFetch(PINATA_UPLOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.pinataJwt}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        log(`[uploads] Pinata upload failed with HTTP ${response.status}; storing locally`);
        return null;
      }
      const cid = ((await response.json()) as { data?: { cid?: unknown } })?.data?.cid;
      if (typeof cid !== 'string' || !CID_RE.test(cid)) {
        log('[uploads] Pinata response had no valid cid; storing locally');
        return null;
      }
      return cid;
    } catch (error) {
      log(`[uploads] Pinata upload failed (${error instanceof Error ? error.name : 'error'}); storing locally`);
      return null;
    }
  }

  app.post('/', async (c) => {
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_CHARS)
      return fail(c, 413, 'PAYLOAD_TOO_LARGE', 'images must be at most 2 MB');
    const body = await c.req.text();
    if (body.length > MAX_BODY_CHARS) return fail(c, 413, 'PAYLOAD_TOO_LARGE', 'images must be at most 2 MB');
    const signed = await verifySignedRequest({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      body,
      address: c.req.header('X-Portex-Address'),
      signature: c.req.header('X-Portex-Signature'),
      ts: c.req.header('X-Portex-Ts'),
      now: opts.now?.(),
    });
    if (!signed.ok) return fail(c, signed.status, signed.code, signed.message);
    const key = signed.address.toLowerCase();
    if (!limiter.allow(key)) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(limiter.retryAfterMs(key) / 1000))));
      return fail(c, 429, 'RATE_LIMITED', 'upload rate limit reached; try again later');
    }
    let json: { contentType?: unknown; data?: unknown };
    try {
      json = JSON.parse(body);
    } catch {
      return fail(c, 400, 'BAD_REQUEST', 'body must be valid JSON');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json))
      return fail(c, 400, 'BAD_REQUEST', 'body must be an object');
    const type = json.contentType;
    if (typeof type !== 'string' || !(type in UPLOAD_TYPES))
      return fail(c, 415, 'UNSUPPORTED_MEDIA_TYPE', 'contentType must be image/png, image/jpeg or image/webp');
    const data = typeof json.data === 'string' ? json.data.replace(/^data:[^,]*;base64,/, '') : null;
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      return fail(c, 400, 'BAD_REQUEST', 'data must be standard base64');
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (bytes.length === 0) return fail(c, 400, 'BAD_REQUEST', 'data is empty');
    if (bytes.length > UPLOAD_MAX_BYTES) return fail(c, 413, 'PAYLOAD_TOO_LARGE', 'images must be at most 2 MB');
    const sniffed = sniffImageType(bytes);
    if (sniffed !== type)
      return fail(
        c,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        sniffed ? `file content is ${sniffed}, not ${type}` : 'file content is not a PNG, JPEG or WebP image',
      );
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${UPLOAD_TYPES[sniffed]}`;
    const cid = await pin(bytes, sniffed, name);
    let result: UploadResult;
    if (cid) {
      result = {
        uri: `ipfs://${cid}`,
        url: `${gatewayOrigin(config)}/ipfs/${cid}`,
        cid,
        contentType: sniffed,
        bytes: bytes.length,
      };
    } else {
      storeLocally(bytes, name);
      const url = `${config.publicApiUrl}/v2/uploads/${name}`;
      result = { uri: url, url, cid: null, contentType: sniffed, bytes: bytes.length };
    }
    return c.json(result, 201);
  });

  app.get('/:file', (c) => {
    const file = c.req.param('file');
    const path = join(dir, file);
    if (!FILE_RE.test(file) || !existsSync(path)) return fail(c, 404, 'NOT_FOUND', 'upload not found');
    return new Response(readFileSync(path), {
      headers: {
        'Content-Type': CONTENT_TYPES[file.split('.')[1]],
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  return app;
}
