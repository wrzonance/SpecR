import { describe, it, expect } from 'vitest';
import { matchTextSignal, matchIndentSignal } from './heuristics.js';

describe('matchTextSignal', () => {
  it('detects PART heading', () => {
    expect(matchTextSignal('PART 1 - GENERAL')).toEqual({ nodeType: 'part', normalizedIlvl: 0 });
  });

  it('detects article (N.N format)', () => {
    expect(matchTextSignal('1.1 REFERENCES')).toEqual({ nodeType: 'article', normalizedIlvl: 1 });
  });

  it('detects pr1 (uppercase letter dot space)', () => {
    expect(matchTextSignal('A. Provide materials')).toEqual({ nodeType: 'pr1', normalizedIlvl: 2 });
  });

  it('detects pr2 (digit dot space)', () => {
    expect(matchTextSignal('1. text here')).toEqual({ nodeType: 'pr2', normalizedIlvl: 3 });
  });

  it('detects pr3 (lowercase letter dot space)', () => {
    expect(matchTextSignal('a. text here')).toEqual({ nodeType: 'pr3', normalizedIlvl: 4 });
  });

  it('detects pr4 (digit paren space)', () => {
    expect(matchTextSignal('1) text here')).toEqual({ nodeType: 'pr4', normalizedIlvl: 5 });
  });

  it('detects pr5 (lowercase letter paren space)', () => {
    expect(matchTextSignal('a) text here')).toEqual({ nodeType: 'pr5', normalizedIlvl: 6 });
  });

  it('does NOT match pr5 for product code with mid-word paren', () => {
    expect(matchTextSignal('Model XR-3i) series specifications')).toBeNull();
  });

  it('does NOT match pr1 for lowercase letter — only uppercase triggers pr1', () => {
    const result = matchTextSignal('a. text');
    expect(result?.nodeType).toBe('pr3');
  });

  it('does NOT match editorial placeholder', () => {
    expect(matchTextSignal('<Insert manufacturer name here>')).toBeNull();
  });

  it('returns null for text shorter than 4 characters', () => {
    expect(matchTextSignal('A.')).toBeNull();
    expect(matchTextSignal('1.')).toBeNull();
  });

  it('returns null for unmatched plain text', () => {
    expect(matchTextSignal('Lorem ipsum dolor sit amet')).toBeNull();
  });
});

describe('matchIndentSignal', () => {
  it('returns 0 for no indentation (part level)', () => {
    expect(matchIndentSignal(0)).toBe(0);
  });

  it('returns 1 for 576 twips (article level)', () => {
    expect(matchIndentSignal(576)).toBe(1);
  });

  it('returns 2 for 1152 twips (pr1 level)', () => {
    expect(matchIndentSignal(1152)).toBe(2);
  });

  it('returns null for undefined leftIndent', () => {
    expect(matchIndentSignal(undefined)).toBeNull();
  });

  it('returns null for ilvl > 8', () => {
    expect(matchIndentSignal(576 * 10)).toBeNull();
  });
});
