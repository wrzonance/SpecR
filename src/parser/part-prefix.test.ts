import { describe, it, expect } from 'vitest';
import { stripPartPrefix } from './part-prefix.js';

describe('stripPartPrefix', () => {
  it('strips "PART n -" and any dash variant, leaving the name', () => {
    expect(stripPartPrefix('PART 3 - EXECUTION')).toBe('EXECUTION'); // hyphen
    expect(stripPartPrefix('PART 1 – GENERAL')).toBe('GENERAL'); // en-dash
    expect(stripPartPrefix('PART 2 — PRODUCTS')).toBe('PRODUCTS'); // em-dash
    expect(stripPartPrefix('PART 2 PRODUCTS')).toBe('PRODUCTS'); // no dash
  });

  it('is case-insensitive on the PART keyword', () => {
    expect(stripPartPrefix('Part 1 - General')).toBe('General');
  });

  it('returns empty for a bare "PART n" with no name (caller decides fallback)', () => {
    expect(stripPartPrefix('PART 1')).toBe('');
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
