/**
 * Builder profile validation + storage shape (PUT /v1/raises/:address/profile).
 * Pure functions, no I/O — unit-tested directly.
 */

export interface BuilderProfile {
  name: string | null;
  tagline: string;
  description: string;
  website: string;
  twitter: string;
  github: string;
  docs: string;
  logoUrl: string | null;
}

export const EMPTY_PROFILE: BuilderProfile = {
  name: null, tagline: '', description: '', website: '', twitter: '', github: '', docs: '', logoUrl: null,
};

const LIMITS = {
  name: 100,
  tagline: 200,
  description: 2000,
  website: 500,
  twitter: 200,
  github: 200,
  docs: 500,
  logoUrl: 500,
} as const;

function isUrl(s: string): boolean {
  return /^https?:\/\/\S+$/.test(s);
}

export type ProfileValidation =
  | { ok: true; profile: BuilderProfile }
  | { ok: false; message: string };

/**
 * Validate a raw request body into a BuilderProfile. Required: tagline (1..200) and
 * description (1..2000). website/twitter/github/docs are strings that may be empty;
 * website/docs/logoUrl must be http(s) URLs when non-empty. name/logoUrl are optional
 * (null when absent or empty).
 */
export function validateProfile(body: unknown): ProfileValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const allowed = new Set([...Object.keys(LIMITS)]);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) return { ok: false, message: `unknown field: ${k}` };
  }

  const str = (key: keyof typeof LIMITS): string | null => {
    const v = b[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new Error(`${key} must be a string`);
    if (v.length > LIMITS[key]) throw new Error(`${key} must be at most ${LIMITS[key]} chars`);
    // no control characters (keep \n out of everything; descriptions are single-paragraph here)
    if (/[\r\n	]/.test(v) && key !== 'description') throw new Error(`${key} must be a single line`);
    return v.trim();
  };

  try {
    const tagline = str('tagline');
    if (!tagline) return { ok: false, message: 'tagline is required (1..200 chars)' };
    const description = str('description');
    if (!description) return { ok: false, message: 'description is required (1..2000 chars)' };
    const website = str('website') ?? '';
    const docs = str('docs') ?? '';
    const logoRaw = str('logoUrl');
    if (website && !isUrl(website)) return { ok: false, message: 'website must be an http(s) URL' };
    if (docs && !isUrl(docs)) return { ok: false, message: 'docs must be an http(s) URL' };
    if (logoRaw && !isUrl(logoRaw)) return { ok: false, message: 'logoUrl must be an http(s) URL' };
    const name = str('name');
    return {
      ok: true,
      profile: {
        name: name || null,
        tagline,
        description,
        website,
        twitter: str('twitter') ?? '',
        github: str('github') ?? '',
        docs,
        logoUrl: logoRaw || null,
      },
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Merge a stored profile (possibly partial JSON) over the legacy description/website columns. */
export function profileFromRow(profileJson: string | null | undefined, description: string, website: string): BuilderProfile {
  let stored: Partial<BuilderProfile> = {};
  try {
    if (profileJson) stored = JSON.parse(profileJson) as Partial<BuilderProfile>;
  } catch { /* corrupt row — fall back to legacy columns */ }
  return {
    name: typeof stored.name === 'string' && stored.name ? stored.name : null,
    tagline: typeof stored.tagline === 'string' ? stored.tagline : '',
    description: typeof stored.description === 'string' && stored.description ? stored.description : description,
    website: typeof stored.website === 'string' && stored.website ? stored.website : website,
    twitter: typeof stored.twitter === 'string' ? stored.twitter : '',
    github: typeof stored.github === 'string' ? stored.github : '',
    docs: typeof stored.docs === 'string' ? stored.docs : '',
    logoUrl: typeof stored.logoUrl === 'string' && stored.logoUrl ? stored.logoUrl : null,
  };
}
