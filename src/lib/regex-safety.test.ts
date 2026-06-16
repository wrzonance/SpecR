import { describe, it, expect } from 'vitest';
import {
  checkRegexPattern,
  checkRegexPatterns,
  MAX_REGEX_PATTERN_LENGTH,
  MAX_REGEX_PATTERNS,
} from './regex-safety.js';

// The two note-banner sources lifted verbatim into the Industry Default seed
// (migration 024) — they must pass the write-boundary safety bound unchanged.
const SEED_BANNERS = [
  '^NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\\b',
  '^SPEC(?:IFIER)?S? NOTES?\\b',
];

describe('checkRegexPattern — accepts safe patterns', () => {
  it.each([
    ...SEED_BANNERS,
    '^abc$',
    'a*b*c*',
    '(?:foo)+',
    '(a|b)*',
    '\\d{1,5}',
    '(a*)?', // bounded outer quantifier — star height 1
    '[)*+]*', // class members are literals; star height 1
    'colou?r',
    '(?<year>\\d{4})-(?<month>\\d{2})',
  ])('accepts %j', (pattern) => {
    expect(checkRegexPattern(pattern)).toEqual({ safe: true });
  });
});

describe('checkRegexPattern — rejects nested unbounded quantifiers (ReDoS)', () => {
  it.each([
    '(a+)+',
    '(a*)*',
    '(a+)*$',
    '([a-z]+)+',
    '((ab)*)*',
    '(a{1,})+', // nested unbounded brace quantifier
    '((a*)?)*', // unboundedness passes through a bounded inner group
  ])('rejects %j', (pattern) => {
    const result = checkRegexPattern(pattern);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/ReDoS|nested/);
  });
});

describe('checkRegexPattern — rejects oversized and invalid patterns', () => {
  it('rejects a pattern longer than the length bound', () => {
    const oversized = 'a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1);
    const result = checkRegexPattern(oversized);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });

  it('accepts a pattern exactly at the length bound', () => {
    expect(checkRegexPattern('a'.repeat(MAX_REGEX_PATTERN_LENGTH))).toEqual({ safe: true });
  });

  it('rejects a pattern that fails to compile', () => {
    const result = checkRegexPattern('(unterminated');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/failed to compile/);
  });
});

describe('checkRegexPatterns — bounds the list', () => {
  it('accepts a small list of safe patterns', () => {
    expect(checkRegexPatterns(SEED_BANNERS)).toEqual({ safe: true });
  });

  it('rejects the list when any member is unsafe', () => {
    const result = checkRegexPatterns(['^ok$', '(a+)+']);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/ReDoS|nested/);
  });

  it('rejects a list exceeding the count bound', () => {
    const many = Array.from({ length: MAX_REGEX_PATTERNS + 1 }, () => '^x$');
    const result = checkRegexPatterns(many);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/too many/);
  });
});
