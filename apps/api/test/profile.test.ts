import { describe, test, expect } from 'bun:test';
import { validateProfile, profileFromRow, EMPTY_PROFILE } from '../src/lib/profile.ts';

const VALID = {
  name: 'Quorum',
  tagline: 'Five reviewers argue so you only read what matters',
  description: 'A swarm of code-review agents.',
  website: 'https://quorum.example.dev',
  twitter: '@quorumreviews',
  github: 'quorum-ai/quorum',
  docs: 'https://docs.quorum.example.dev',
  logoUrl: 'https://quorum.example.dev/logo.png',
};

describe('validateProfile', () => {
  test('accepts a full valid profile', () => {
    const res = validateProfile(VALID);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.profile).toEqual(VALID);
  });

  test('accepts the minimal profile (optional fields omitted)', () => {
    const res = validateProfile({ tagline: 'hi', description: 'a project', website: '', twitter: '', github: '', docs: '' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.profile.name).toBeNull();
      expect(res.profile.logoUrl).toBeNull();
    }
  });

  test('rejects missing tagline / description', () => {
    expect(validateProfile({ ...VALID, tagline: '' }).ok).toBe(false);
    expect(validateProfile({ ...VALID, description: '' }).ok).toBe(false);
    expect(validateProfile({ website: 'https://x.dev' }).ok).toBe(false);
  });

  test('rejects non-http(s) URLs', () => {
    expect(validateProfile({ ...VALID, website: 'javascript:alert(1)' }).ok).toBe(false);
    expect(validateProfile({ ...VALID, docs: 'ftp://x' }).ok).toBe(false);
    expect(validateProfile({ ...VALID, logoUrl: 'notaurl' }).ok).toBe(false);
  });

  test('rejects over-long fields and wrong types', () => {
    expect(validateProfile({ ...VALID, tagline: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateProfile({ ...VALID, description: 'x'.repeat(2001) }).ok).toBe(false);
    expect(validateProfile({ ...VALID, twitter: 42 }).ok).toBe(false);
    expect(validateProfile(null).ok).toBe(false);
    expect(validateProfile('string').ok).toBe(false);
  });

  test('rejects unknown fields', () => {
    expect(validateProfile({ ...VALID, admin: true }).ok).toBe(false);
  });
});

describe('profileFromRow', () => {
  test('falls back to legacy description/website columns', () => {
    expect(profileFromRow('{}', 'legacy description', 'https://legacy.dev')).toEqual({
      ...EMPTY_PROFILE,
      description: 'legacy description',
      website: 'https://legacy.dev',
    });
  });

  test('stored profile wins over legacy columns', () => {
    const stored = JSON.stringify({ tagline: 't', description: 'new', website: 'https://new.dev', twitter: '@new' });
    const p = profileFromRow(stored, 'old', 'https://old.dev');
    expect(p.description).toBe('new');
    expect(p.website).toBe('https://new.dev');
    expect(p.twitter).toBe('@new');
    expect(p.tagline).toBe('t');
  });

  test('corrupt JSON degrades to legacy columns', () => {
    const p = profileFromRow('{oops', 'legacy', '');
    expect(p.description).toBe('legacy');
  });
});
