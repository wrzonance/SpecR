import { describe, it, expect } from 'vitest';
import {
  stripPartPrefix,
  planPartStrip,
  planOutlineNumberStrip,
  planLabelStrip,
  rebaseSourceFacts,
} from './part-prefix.js';
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

  // Regression (WIRELESS_ACCESS_POINTS.docx): PART headings authored as "N.0 NAME"
  // ("2.0 PRODUCTS") are classified as parts, so the render-derived "PART n -" label
  // re-adds the tier — the stored name must NOT keep the "2.0 " prefix or it renders
  // "PART 2 - 2.0 PRODUCTS". Strip the whole-number decimal prefix down to the name.
  it('strips a whole-number decimal PART prefix ("N.0 NAME") down to the name', () => {
    expect(stripPartPrefix('2.0 PRODUCTS')).toBe('PRODUCTS');
    expect(stripPartPrefix('3.0 EXECUTION')).toBe('EXECUTION');
    expect(stripPartPrefix('1.0 GENERAL')).toBe('GENERAL');
    expect(stripPartPrefix('2.00 PRODUCTS')).toBe('PRODUCTS');
  });

  // Only whole-number (N.0) decimals are a PART tier — a real "N.N" article number
  // (e.g. "2.1 SUMMARY") is never stripped, so if such text ever reached the stripper
  // it is left intact rather than mangled.
  it('does not strip a non-zero decimal (article) number', () => {
    expect(stripPartPrefix('2.1 SUMMARY')).toBe('2.1 SUMMARY');
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

describe('planOutlineNumberStrip (MULTI-DOT outline items only — Signal 4 pr nodes)', () => {
  // A multi-dot number ("1.4.2.1 Install…") is unambiguously an outline number (never a
  // measurement) and its pr render label ("A." / "1.") never contains the typed decimal,
  // so it is always safe to strip. WIRELESS_ACCESS_POINTS.docx types its deep outline
  // this way. A single-dot "N.N" is NOT handled here (ambiguous with a value like
  // "2.1 GHz") — planLabelStrip handles it, and only when it equals the node's label.
  it('strips a multi-dot decimal outline prefix (>=2 interior dots) down to the text', () => {
    expect(planOutlineNumberStrip('1.4.2.1 Installation Instructions')?.text).toBe(
      'Installation Instructions'
    );
    expect(planOutlineNumberStrip('2.3.4.5.6 Deep item')?.text).toBe('Deep item');
    expect(planOutlineNumberStrip('1.1.1 Wi-Tile')?.text).toBe('Wi-Tile');
  });

  it('does NOT strip a single-dot "N.N" (ambiguous with a value like "2.1 GHz")', () => {
    expect(planOutlineNumberStrip('1.2 RELATED SECTIONS')).toBeNull();
    expect(planOutlineNumberStrip('2.1 GHz frequency band')).toBeNull();
    expect(planOutlineNumberStrip('2.0 inches of clearance minimum')).toBeNull();
  });

  it('does NOT strip a bare "N." (the pr2 label form) or an alpha prefix', () => {
    expect(planOutlineNumberStrip('1. text here')).toBeNull(); // no interior dot
    expect(planOutlineNumberStrip('B. Included in this section')).toBeNull(); // alpha
    expect(planOutlineNumberStrip('SUMMARY')).toBeNull();
  });

  it('returns null when stripping would empty the text (bare number)', () => {
    expect(planOutlineNumberStrip('1.4.2')).toBeNull();
  });
});

describe('planLabelStrip (single-dot article number — only when it IS the label)', () => {
  // The ONLY reliable way to tell an outline LABEL from a decimal VALUE: strip "1.2"
  // from an article iff "1.2" is that article's own sibling-derived CSI label. So a real
  // heading at its matching position strips clean, while a measurement never does (its
  // number is not that position's label).
  it('strips the number when it equals the article label', () => {
    expect(planLabelStrip('1.2 RELATED SECTIONS', '1.2')).toEqual({
      text: 'RELATED SECTIONS',
      removed: 4,
    });
    expect(planLabelStrip('1.2 Related Sections', '1.2')?.text).toBe('Related Sections');
    expect(planLabelStrip('1.4 SUBMITTALS', '1.4')?.text).toBe('SUBMITTALS');
    expect(planLabelStrip('10.11 SCHEDULES', '10.11')?.text).toBe('SCHEDULES');
    // separator variants (dash/colon) between the label and the title
    expect(planLabelStrip('1.2 - RELATED SECTIONS', '1.2')?.text).toBe('RELATED SECTIONS');
    expect(planLabelStrip('1.2: SUMMARY', '1.2')?.text).toBe('SUMMARY');
  });

  it('does NOT strip a measurement whose number is not this article label (no data loss)', () => {
    // "2.1 GHz …" sitting at, say, article 1.3 — its "2.1" is a value, not the label.
    expect(planLabelStrip('2.1 GHz frequency band', '1.3')).toBeNull();
    expect(planLabelStrip('1.5 MHz reference clock', '2.4')).toBeNull();
    expect(planLabelStrip('2.0 inches of clearance minimum', '1.1')).toBeNull();
    // even a capital unit is safe — "2.0 GHz" is only stripped if 2.0 IS the label
    expect(planLabelStrip('2.0 GHz frequency band', '1.1')).toBeNull();
  });

  // Codex adversarial review (P2 data-loss): a heading title is capitalized (ALL-CAPS or
  // Title-Case) — a real article never opens with a lowercase word — so we require an
  // UPPERCASE letter after the label before stripping. This preserves decimal PROSE whose
  // number happens to equal its computed label ("1.1 inches of clearance minimum" sitting
  // at article 1.1) and lowercase-unit measurements ("1.1 mm tolerance", "2.1 kHz clock"),
  // which read as sentence fragments, not titles. Every real corpus heading passes this.
  it('does NOT strip when a lowercase word follows the label (decimal prose, not a heading)', () => {
    expect(planLabelStrip('1.1 inches of clearance minimum', '1.1')).toBeNull();
    expect(planLabelStrip('1.1 mm tolerance', '1.1')).toBeNull();
    expect(planLabelStrip('2.1 kHz reference clock', '2.1')).toBeNull();
  });

  // Corollary: a title starting with a digit (not [A-Z]) is left intact rather than risk
  // stripping a measurement like "1.2 600 volts minimum". No data loss — a genuine
  // digit-leading heading merely renders its label doubled (recoverable), which the
  // conservative direction prefers over destroying a value.
  it('does NOT strip when a digit follows the label (ambiguous with a value)', () => {
    expect(planLabelStrip('1.2 600 volts minimum required', '1.2')).toBeNull();
  });

  it('matches the label as a whole token — "1.2" never strips inside "12.3"', () => {
    expect(planLabelStrip('12.3 kV switchgear rating', '1.2')).toBeNull();
  });

  it('returns null when stripping would empty the text (label with no title)', () => {
    expect(planLabelStrip('1.2 ', '1.2')).toBeNull();
    expect(planLabelStrip('1.2', '1.2')).toBeNull();
  });

  // Multi-dot numbers (>=2 interior dots) are unambiguously outline — a measurement is
  // never "1.4.2.1" — so they strip regardless of the following letter's case.
  it('strips a deep (multi-dot) outline number even when a lowercase word follows', () => {
    expect(planOutlineNumberStrip('1.4.2.1 installation instructions')?.text).toBe(
      'installation instructions'
    );
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
