import { describe, it, expect } from 'vitest';
import { containsSpecifierNoteBanner } from './specifier-note-banner.js';

describe('containsSpecifierNoteBanner', () => {
  // Banners anywhere in the line (contains-style, unlike the parser's anchored use).
  const hits = [
    '** NOTE TO SPECIFIER ** delete items below',
    "Display hidden notes to specifier. (Don't know how? Click Here)",
    'SPECIFIER NOTES: coordinate with Division 26',
    'NOTES TO SPEC WRITER — choose one',
    'trailing banner then SPEC NOTE here',
    'NOTE   TO   THE   SPECIFIER — multi-space, must still match', // whitespace collapsed like the parser
  ];
  for (const t of hits) {
    it(`matches: ${t.slice(0, 40)}`, () => expect(containsSpecifierNoteBanner(t)).toBe(true));
  }

  const misses = [
    'Provide inspector notes to the owner.', // "inspector notes" ≠ banner
    'The following products are noteworthy.',
    'Structural steel shall comply with ASTM A992.',
    '',
  ];
  for (const t of misses) {
    it(`rejects: ${t.slice(0, 40)}`, () => expect(containsSpecifierNoteBanner(t)).toBe(false));
  }
});
