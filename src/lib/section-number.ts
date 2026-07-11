// src/lib/section-number.ts
import { z } from 'zod';

/**
 * Canonical CSI/UFGS section-number grammar (expanded shape):
 *   NN NN NN            — MasterFormat Level 3            (26 00 13)
 *   NN NN NN.NN         — Level 4 dotted suffix           (26 00 13.10)
 *   NN NN NN.NN NN      — Level 5 agency suffix, UFGS     (01 32 01.00 10)
 * Each shape is a DISTINCT section identity. See ADR-020.
 */
export const SECTION_NUMBER_RE = /^\d{2} \d{2} \d{2}(?:\.\d{2}(?: \d{2})?)?$/;
const CANONICAL_PARTS_RE = /^(\d{2}) (\d{2}) (\d{2})(?:\.(\d{2})(?: (\d{2}))?)?$/;

export const SECTION_NUMBER_FORMATS = ['canonical', 'dots', 'compact', 'spaced-compact'] as const;
export type SectionNumberFormat = (typeof SECTION_NUMBER_FORMATS)[number];
export const SectionNumberFormatSchema = z.enum(SECTION_NUMBER_FORMATS);

export type SectionNumberParseContext = 'canonical' | 'strong';
export type SectionNumberParseFailureReason = 'empty' | 'not-canonical' | 'invalid-format';

export type SectionNumberParseResult =
  | {
      readonly ok: true;
      readonly canonical: string;
      readonly inputFormat: SectionNumberFormat;
      readonly confidence: 'high';
    }
  | {
      readonly ok: false;
      readonly reason: SectionNumberParseFailureReason;
    };

// Scanner fragment. Differences from SECTION_NUMBER_RE, all deliberate:
// - `\s+` separators: tolerates NBSP/multi-space/newline dirt found in real
//   documents (JS `\s` includes  ); normalizeSectionNumber canonicalizes.
// - Agency separator is horizontal-only ([^\S\r\n]) so a 2-digit token on the
//   NEXT LINE is never absorbed as an agency suffix.
// - (?<![\d.]) / (?!\d) guards: never match inside longer numbers (26 00 134,
//   version strings, years).
// - ONE capture group wrapping the whole number: consumers embed the fragment
//   and recover the value via normalizeSectionNumber(match[1]).
const FRAGMENT = String.raw`(?<![\d.])(\d{2}\s+\d{2}\s+\d{2}(?:\.\d{2}(?!\d)(?:[^\S\r\n]+\d{2}(?!\d))?)?)(?!\d)`;

// Strong contexts already say "this token is intended to be a CSI section":
// SECTION headers, tagged <SCN>/<SRF>, and validated API fields. That lets us
// admit common display variants while keeping bare free-prose scanning strict.
const STRONG_FRAGMENT = String.raw`(?<![\d.])((?:\d{2}\s+\d{2}\s+\d{2}|\d{2}\s+\d{4}|\d{2}\.\d{2}\.\d{2}|\d{6})(?:\.\d{2}(?!\d)(?:[^\S\r\n]+\d{2}(?!\d))?)?)(?!\d)(?!\.\d)`;
const DOTS_RE = /^(\d{2})\.(\d{2})\.(\d{2})(?:\.(\d{2})(?: (\d{2}))?)?$/;
const COMPACT_RE = /^(\d{2})(\d{2})(\d{2})(?:\.(\d{2})(?: (\d{2}))?)?$/;
const SPACED_COMPACT_RE = /^(\d{2}) (\d{2})(\d{2})(?:\.(\d{2})(?: (\d{2}))?)?$/;

/**
 * Regex source fragment for embedding in larger scanners (keyword/prose/bare).
 *
 * Capture-group contract: the fragment wraps the whole section number in
 * exactly ONE capture group, so group 1 is always the full number. Any groups
 * a consumer adds around the fragment therefore start at index 2. Recover the
 * canonical value via normalizeSectionNumber(match[1]).
 */
export function sectionNumberFragment(): string {
  return FRAGMENT;
}

/**
 * Regex source fragment for strong section-number contexts. Capture-group
 * contract matches sectionNumberFragment(): exactly ONE group containing the
 * raw candidate, which may be canonical or a recognized display variant.
 */
export function sectionNumberCandidateFragment(): string {
  return STRONG_FRAGMENT;
}

/**
 * Canonicalize a raw section-number string: NBSP→space, collapse whitespace
 * runs, trim. Returns the canonical form, or null when the result is not a
 * valid expanded-shape section number.
 */
export function normalizeSectionNumber(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return SECTION_NUMBER_RE.test(collapsed) ? collapsed : null;
}

function canonicalFromParts(
  first: string,
  second: string,
  third: string,
  suffix: string | undefined,
  agency: string | undefined
): string {
  const base = `${first} ${second} ${third}`;
  if (suffix === undefined) return base;
  return agency === undefined ? `${base}.${suffix}` : `${base}.${suffix} ${agency}`;
}

function variantFromMatch(
  match: RegExpExecArray,
  inputFormat: SectionNumberFormat
): SectionNumberParseResult | null {
  const first = match[1];
  const second = match[2];
  const third = match[3];
  if (first === undefined || second === undefined || third === undefined) return null;
  return {
    ok: true,
    canonical: canonicalFromParts(first, second, third, match[4], match[5]),
    inputFormat,
    confidence: 'high',
  };
}

function parseStrongVariant(collapsed: string): SectionNumberParseResult | null {
  const patterns: readonly {
    readonly inputFormat: SectionNumberFormat;
    readonly pattern: RegExp;
  }[] = [
    { inputFormat: 'dots', pattern: DOTS_RE },
    { inputFormat: 'compact', pattern: COMPACT_RE },
    { inputFormat: 'spaced-compact', pattern: SPACED_COMPACT_RE },
  ];
  for (const { inputFormat, pattern } of patterns) {
    const match = pattern.exec(collapsed);
    if (match !== null) return variantFromMatch(match, inputFormat);
  }
  return null;
}

export function parseSectionNumberCandidate(
  raw: string,
  context: SectionNumberParseContext = 'canonical'
): SectionNumberParseResult {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return { ok: false, reason: 'empty' };
  const canonical = normalizeSectionNumber(collapsed);
  if (canonical !== null) {
    return { ok: true, canonical, inputFormat: 'canonical', confidence: 'high' };
  }
  if (context === 'canonical') return { ok: false, reason: 'not-canonical' };
  return parseStrongVariant(collapsed) ?? { ok: false, reason: 'invalid-format' };
}

export const SectionNumberInputSchema = z.string().transform((raw, ctx) => {
  const parsed = parseSectionNumberCandidate(raw, 'strong');
  if (!parsed.ok) {
    ctx.addIssue({ code: 'custom', message: 'invalid section number' });
    return z.NEVER;
  }
  return parsed.canonical;
});

function canonicalParts(canonical: string): RegExpExecArray {
  const match = CANONICAL_PARTS_RE.exec(canonical);
  if (match === null) {
    throw new Error('section number must be canonical before formatting');
  }
  return match;
}

export function formatSectionNumber(canonical: string, format: SectionNumberFormat): string {
  const parts = canonicalParts(canonical);
  const first = parts[1] ?? '';
  const second = parts[2] ?? '';
  const third = parts[3] ?? '';
  const suffix = parts[4] === undefined ? '' : `.${parts[4]}`;
  const agency = parts[5] === undefined ? '' : ` ${parts[5]}`;
  switch (format) {
    case 'canonical':
      return canonical;
    case 'dots':
      return `${first}.${second}.${third}${suffix}${agency}`;
    case 'compact':
      return `${first}${second}${third}${suffix}${agency}`;
    case 'spaced-compact':
      return `${first} ${second}${third}${suffix}${agency}`;
  }
  const exhaustive: never = format;
  return exhaustive;
}

/**
 * Format a section number for display, tolerating input that isn't (yet)
 * canonical. Normalizes `section` and formats it when possible; otherwise
 * returns `section` verbatim rather than throwing or guessing.
 */
export function displaySectionNumber(section: string, format: SectionNumberFormat): string {
  const canonical = normalizeSectionNumber(section);
  return canonical === null ? section : formatSectionNumber(canonical, format);
}

export function formatSectionReferences(text: string, format: SectionNumberFormat): string {
  const re = new RegExp(String.raw`\b(Section\s+)${STRONG_FRAGMENT}`, 'gi');
  let out = '';
  let lastIndex = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index;
    const prefix = match[1];
    const raw = match[2];
    if (prefix === undefined || raw === undefined) continue;
    const parsed = parseSectionNumberCandidate(raw, 'strong');
    if (!parsed.ok) continue;
    out += text.slice(lastIndex, index);
    out += `${prefix}${formatSectionNumber(parsed.canonical, format)}`;
    lastIndex = index + match[0].length;
  }
  return `${out}${text.slice(lastIndex)}`;
}

export interface SectionMatch {
  readonly value: string;
  readonly index: number;
}

/** Scan free text for section-number citations; values come back normalized. */
export function findSectionNumbers(text: string): readonly SectionMatch[] {
  const re = new RegExp(FRAGMENT, 'g');
  const out: SectionMatch[] = [];
  for (const m of text.matchAll(re)) {
    const value = normalizeSectionNumber(m[1] ?? '');
    // RegExpMatchArray.index is optional in TS lib typings — guard for strict mode
    if (value !== null && typeof m.index === 'number') out.push({ value, index: m.index });
  }
  return out;
}

/** Zod gate for canonical section numbers (does NOT admit the 'unknown' sentinel). */
export const SectionNumberSchema = z.string().regex(SECTION_NUMBER_RE);
