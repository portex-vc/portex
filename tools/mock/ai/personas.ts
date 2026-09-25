/**
 * Stable "minds" for the mock personas: investing style, risk tolerance, expertise, voice and language, fixed per
 * persona index so a persona sounds the same across runs. Nothing here is secret; profiles go into system prompts.
 */
import { hash } from '../lib/random';
import type { PersonaKind } from '../lib/wallets';

export type Language = 'en' | 'zh' | 'en+zh';

export interface Mind {
  label: string;
  kind: PersonaKind;
  style: string;
  /** 0 (very cautious) .. 1 (aggressive). */
  risk: number;
  expertise: string[];
  voice: string;
  language: Language;
  /** Deposit size range in USDG when backing. */
  ticket: [number, number];
}

const BASE: Record<PersonaKind, { style: string; risk: [number, number]; ticket: [number, number] }> = {
  builder: {
    style: 'Founder of an early AI startup; judges peers by shipping pace and honesty about limits.',
    risk: [0.4, 0.6],
    ticket: [500, 3000],
  },
  conservative: {
    style:
      'Principal-first early backer. Backs teams with evidence of real use, sizes positions modestly, and exits at cost without drama when the evidence weakens.',
    risk: [0.2, 0.4],
    ticket: [800, 6000],
  },
  rollover: {
    style:
      'Active allocator who moves capital between early projects, comparing each raise with the alternatives open right now.',
    risk: [0.45, 0.65],
    ticket: [800, 5000],
  },
  stage2: {
    style: 'Short-horizon trader who reads order flow and news; rarely backs in Stage 1.',
    risk: [0.6, 0.8],
    ticket: [300, 2000],
  },
  stage3: {
    style: 'Open-market trader focused on liquidity and momentum after listing.',
    risk: [0.6, 0.85],
    ticket: [300, 2000],
  },
  whale: {
    style:
      'Large, patient backer. Cares about market size, team depth and whether the raise size fits the plan; asks hard questions before committing.',
    risk: [0.45, 0.65],
    ticket: [5000, 30000],
  },
  voter: {
    style:
      'Governance-minded backer who reads every update, cares about milestones, budget discipline and treasury restraint.',
    risk: [0.3, 0.5],
    ticket: [800, 4000],
  },
};

const EXPERTISE = [
  'ML infrastructure and inference cost',
  'applied ML research and evaluation',
  'healthcare workflows and clinical safety',
  'climate and agriculture data',
  'fintech operations and controls',
  'security and access management',
  'developer tools',
  'robotics and field operations',
  'education products',
  'legal operations',
  'creative and media tools',
  'logistics and supply chains',
  'data licensing and privacy',
];

const VOICES = [
  'terse and numerical; leads with the one number that matters',
  'warm but direct; names one strength and one concern',
  'skeptical; ends with a single pointed question',
  'methodical; says what evidence would change their mind',
  'plain-spoken operator; compares with how teams actually buy software',
  'quietly curious; asks about the hardest part of the plan',
];

/** Two personas write partly or wholly in Chinese; everyone else writes English. */
const LANGUAGE: Record<string, Language> = { 'conservative-3': 'zh', 'whale-2': 'en+zh', 'voter-3': 'en+zh' };

export function mindFor(persona: { index: number; kind: PersonaKind; label: string }): Mind {
  const h = hash(`mind:${persona.label}:${persona.index}`);
  const base = BASE[persona.kind];
  const pickExpertise = (n: number) => {
    const out: string[] = [];
    for (let i = 0; out.length < n; i++) {
      const e = EXPERTISE[(h + i * 7) % EXPERTISE.length];
      if (!out.includes(e)) out.push(e);
    }
    return out;
  };
  const risk = base.risk[0] + ((h % 1000) / 1000) * (base.risk[1] - base.risk[0]);
  const scale = 0.8 + ((Math.floor(h / 1000) % 100) / 100) * 0.4;
  return {
    label: persona.label,
    kind: persona.kind,
    style: base.style,
    risk: Math.round(risk * 100) / 100,
    expertise: pickExpertise(2),
    voice: VOICES[Math.floor(h / 7) % VOICES.length],
    language: LANGUAGE[persona.label] ?? 'en',
    ticket: [Math.round(base.ticket[0] * scale), Math.round(base.ticket[1] * scale)],
  };
}

export function languageRule(language: Language): string {
  if (language === 'zh')
    return 'Write the feedback and question in Simplified Chinese (简体中文), with full-width punctuation.';
  if (language === 'en+zh')
    return 'Write mostly in English; you may add one short sentence in Simplified Chinese when it comes naturally.';
  return 'Write in English.';
}

export function describeMind(m: Mind): string {
  return [
    `Style: ${m.style}`,
    `Risk tolerance: ${Math.round(m.risk * 10)}/10.`,
    `Expertise: ${m.expertise.join('; ')}.`,
    `Voice: ${m.voice}.`,
    languageRule(m.language),
  ].join('\n');
}
