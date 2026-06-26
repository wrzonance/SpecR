import { describe, it, expect } from 'vitest';
import { stripPartPrefix, planPartStrip, rebaseSourceFacts } from './part-prefix.js';
import type { SourceFacts } from '../ast/types.js';

describe('stripPartPrefix', () => {
  it('strips "PART n -" and any dash variant, leaving the name', () => {
    expect(stripPartPrefix('PART 3 - EXECUTION')).toBe('EXECUTION'); // hyphen
    expect(stripPartPrefix('PART 1 – GENERAL')).toBe('GENERAL'); // en-dash
    expect(stripPartPrefix('PART 2 — PRODUCTS')).toBe('PRODUCTS'); // em-dash
    expect(stripPartPrefix('PART 2 PRODUCTS')).toBe('PRODUCTS'); // no dash
  });

  // Codex review: colon/period separators must be consumed too (space or not),
  // never left dangling as ": GENERAL" / ".EXECUTION".
  it('strips a colon or period separator, with or without a following space', () => {
    expect(stripPartPrefix('PART 1: GENERAL')).toBe('GENERAL');
    expect(stripPartPrefix('PART 3. EXECUTION')).toBe('EXECUTION');
    expect(stripPartPrefix('PART 1:GENERAL')).toBe('GENERAL');
    expect(stripPartPrefix('PART 3.EXECUTION')).toBe('EXECUTION');
  });

  it('is case-insensitive on the PART keyword', () => {
    expect(stripPartPrefix('Part 1 - General')).toBe('General');
  });

  // Codex review: never partial-strip — without a real delimiter, leave the text
  // alone rather than emit stray punctuation (": GENERAL", ".0 SUMMARY").
  it('does not strip when no real delimiter follows the number', () => {
    expect(stripPartPrefix('PART 1.0 SUMMARY')).toBe('PART 1.0 SUMMARY'); // version-like decimal
    expect(stripPartPrefix('PART 1')).toBe('PART 1'); // bare, no name
  });

  // Codex review (regression): the classifiers (isPartHeading / signals PART_RE,
  // both /^PART\s+\d+/i on trimmed text) accept a de-spaced "PART 1GENERAL" and a
  // leading-whitespace heading as PART nodes, so the stripper MUST strip them too —
  // otherwise the render-time label doubles into "PART 1 - PART 1GENERAL". A letter
  // glued to the number is a clean cut (no stray punctuation).
  it('strips a name glued directly to the number, and tolerates leading whitespace', () => {
    expect(stripPartPrefix('PART 1GENERAL')).toBe('GENERAL'); // de-spaced (lossy PDF/text)
    expect(stripPartPrefix('PART 2PRODUCTS')).toBe('PRODUCTS');
    expect(stripPartPrefix('  PART 1 - GENERAL')).toBe('GENERAL'); // leading whitespace
  });

  it('leaves a bare part name untouched', () => {
    expect(stripPartPrefix('EXECUTION')).toBe('EXECUTION');
  });

  it('does not strip a word that merely starts with "PART" (e.g. PARTITION)', () => {
    expect(stripPartPrefix('PARTITION 1 SYSTEMS')).toBe('PARTITION 1 SYSTEMS');
  });

  it('does not touch prose that has no leading PART prefix', () => {
    expect(stripPartPrefix('General requirements apply to PART 2.')).toBe(
      'General requirements apply to PART 2.'
    );
  });
});

describe('planPartStrip', () => {
  it('returns the stripped text + leading chars removed', () => {
    expect(planPartStrip('PART 3 - EXECUTION')).toEqual({ text: 'EXECUTION', removed: 9 });
  });

  it('returns null when there is no PART prefix (no strip)', () => {
    expect(planPartStrip('EXECUTION')).toBeNull();
  });

  it('returns null when stripping would empty the text (bare "PART n")', () => {
    expect(planPartStrip('PART 1')).toBeNull();
  });
});

describe('rebaseSourceFacts (Codex review: keep fact offsets valid after prefix strip)', () => {
  it('shifts comment/color/choice offsets left by the removed prefix length', () => {
    // "PART 3 - EXECUTION" (facts on EXECUTION at 9..18) → "EXECUTION" (0..9)
    const facts: SourceFacts = {
      comments: [{ author: 'A', text: 'see spec', anchor: [9, 18], closed: false }],
      colors: [{ color: 'FF0000', coverage: 0.5, spans: [[9, 18]] }],
      choiceTokens: [{ kind: 'bracket', options: ['x'], span: [9, 18] }],
    };
    const out = rebaseSourceFacts(facts, 9, 9);
    expect(out.comments?.[0]?.anchor).toEqual([0, 9]);
    expect(out.colors?.[0]?.spans).toEqual([[0, 9]]);
    expect(out.colors?.[0]?.coverage).toBe(1); // 9 covered / 9 new length
    expect(out.choiceTokens?.[0]?.span).toEqual([0, 9]);
  });

  it('drops facts that lay entirely within the stripped prefix', () => {
    const facts: SourceFacts = { colors: [{ color: 'FF0000', coverage: 1, spans: [[0, 6]] }] };
    expect(rebaseSourceFacts(facts, 9, 9).colors).toBeUndefined();
  });

  it('keeps a zero-length (point) comment anchor sitting after the prefix (w:commentReference)', () => {
    // A point comment at the start of "EXECUTION" → anchor [9,9]; after removing
    // "PART 3 - " it must shift to [0,0], not be dropped as if it were prefix-only.
    const facts: SourceFacts = {
      comments: [{ author: 'A', text: 'point', anchor: [9, 9], closed: false }],
    };
    expect(rebaseSourceFacts(facts, 9, 9).comments?.[0]?.anchor).toEqual([0, 0]);
  });

  it('drops a zero-length comment anchor that lay inside the stripped prefix', () => {
    const facts: SourceFacts = {
      comments: [{ author: 'A', text: 'point', anchor: [3, 3], closed: false }],
    };
    expect(rebaseSourceFacts(facts, 9, 9).comments).toBeUndefined();
  });

  it('preserves non-positional facts (banner, vanish) and is a no-op when nothing removed', () => {
    const facts: SourceFacts = { banner: 'NOTE TO SPECIFIER', vanish: true };
    expect(rebaseSourceFacts(facts, 0, 5)).toBe(facts);
    expect(rebaseSourceFacts(facts, 9, 9).banner).toBe('NOTE TO SPECIFIER');
  });
});
