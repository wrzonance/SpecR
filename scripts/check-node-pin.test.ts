import { describe, expect, it } from 'vitest';

import { majorFromEngineRange, NodePinError } from './check-node-pin.js';

const parse = (range: string): number => majorFromEngineRange(range, 'test');

describe('majorFromEngineRange', () => {
  describe('accepts canonical single-major pins', () => {
    it.each([
      ['^24', 24],
      ['^24.13.3', 24],
      ['>=24 <25', 24],
      ['>=24.17.0 <25', 24],
      ['>=24 <25.0', 24],
      ['>=24 <25.0.0', 24],
      ['>= 24 < 25', 24],
      ['  >=24 <25  ', 24],
    ])('%s → major %i', (range, expected) => {
      expect(parse(range)).toBe(expected);
    });
  });

  describe('rejects ranges that do not pin exactly one major', () => {
    // Regression: an open-ended floor is the original drift bug — `>=22.17.0`
    // was satisfied by Node 26 while CI ran Node 22.
    it('rejects an open-ended floor', () => {
      expect(() => parse('>=24')).toThrow(NodePinError);
      expect(() => parse('>=24')).toThrow(/open-ended/);
    });

    // Regression: a union's caret prefix looks valid, so prefix-matching alone
    // returned 24 and passed the gate while Node 27 still satisfied the range.
    it.each(['^24 || ^27', '>=24 <25 || >=27', '^24||^26'])('rejects the union %s', (range) => {
      expect(() => parse(range)).toThrow(/union range/);
    });

    // Regression: the upper bound was matched by a first-digit-run scan, so
    // `<25.5` read as `<25` and passed while admitting Node 25.0–25.4.
    it.each(['>=24 <25.5', '>=24 <25.1.0'])('rejects the leaky upper bound %s', (range) => {
      expect(() => parse(range)).toThrow(/not a recognized single-major pin/);
    });

    it('rejects an upper bound that is not the next major', () => {
      expect(() => parse('>=24 <26')).toThrow(/a single-major pin ends at <25/);
    });

    it('rejects a wildcard', () => {
      expect(() => parse('*')).toThrow(NodePinError);
    });

    it('rejects an empty range', () => {
      expect(() => parse('')).toThrow(NodePinError);
    });
  });

  describe('fails closed on spellings it cannot prove', () => {
    // These pin one major in semver but are not the canonical spellings. The
    // gate deliberately rejects rather than guesses — but the message must name
    // the real problem, not misdiagnose it.
    it.each(['24', '24.x', '~24.2', '<25 >=24', '>=24<25', '>=24 <=24.20'])(
      'rejects %s with a specific message',
      (range) => {
        expect(() => parse(range)).toThrow(NodePinError);
      }
    );

    it('does not call a bounded-but-noncanonical range "open-ended"', () => {
      expect(() => parse('>=24 <=24.20')).toThrow(/not a recognized single-major pin/);
    });

    // Regression: these resolve to bounded ranges in semver ("24" and "24.x" →
    // >=24.0.0 <25.0.0, "~24.2" → >=24.2.0 <24.3.0), so diagnosing them as
    // "open-ended" named a problem they do not have.
    it.each(['24', '24.x', '24.X', '~24.2'])(
      'diagnoses %s as non-canonical, not open-ended',
      (range) => {
        expect(() => parse(range)).toThrow(/not a recognized single-major pin/);
      }
    );

    // The complement: a bare floor genuinely is open-ended and must still say so.
    it.each(['>=24', '>= 24', '>=24.17.0'])('still calls %s open-ended', (range) => {
      expect(() => parse(range)).toThrow(/open-ended/);
    });
  });

  it('never returns a major for a range satisfied by a later major', () => {
    // The invariant the gate exists to hold: anything it accepts must be
    // unsatisfiable by major+1.
    for (const range of ['^24 || ^27', '>=24', '>=24 <26', '>=24 <25.5', '*']) {
      expect(() => parse(range)).toThrow();
    }
  });
});
