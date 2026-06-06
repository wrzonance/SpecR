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

/** Regex source fragment for embedding in larger scanners (keyword/prose/bare). */
export function sectionNumberFragment(): string {
  return FRAGMENT;
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
