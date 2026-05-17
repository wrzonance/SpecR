import { describe, it, expect } from 'vitest';
import { classifyLine } from './signals.js';

describe('classifyLine', () => {
  it('blank line returns type blank', () => {
    expect(classifyLine('')).toEqual({ type: 'blank', text: '', level: -1 });
    expect(classifyLine('   ')).toEqual({ type: 'blank', text: '', level: -1 });
  });

  it('SECTION header detected', () => {
    const r = classifyLine('SECTION 27 10 00 - BUILDING TELECOMMUNICATIONS CABLING SYSTEM');
    expect(r.type).toBe('header');
    expect(r.level).toBe(-1);
  });

  it('PART heading strips numeric prefix', () => {
    const r = classifyLine('PART 1 - GENERAL');
    expect(r.type).toBe('part');
    expect(r.text).toBe('GENERAL');
    expect(r.level).toBe(0);
  });

  it('PART heading without dash still classified', () => {
    const r = classifyLine('PART 2 PRODUCTS');
    expect(r.type).toBe('part');
    expect(r.level).toBe(0);
  });

  it('article heading strips N.N prefix', () => {
    const r = classifyLine('1.1 REFERENCES');
    expect(r.type).toBe('article');
    expect(r.text).toBe('REFERENCES');
    expect(r.level).toBe(1);
  });

  it('article with double-digit section number', () => {
    const r = classifyLine('10.1 GENERAL');
    expect(r.type).toBe('article');
    expect(r.text).toBe('GENERAL');
  });

  it('pr1 strips uppercase letter prefix', () => {
    const r = classifyLine('A. First requirement');
    expect(r.type).toBe('pr1');
    expect(r.text).toBe('First requirement');
    expect(r.level).toBe(2);
  });

  it('pr2 strips numeric period prefix', () => {
    const r = classifyLine('1. First item');
    expect(r.type).toBe('pr2');
    expect(r.text).toBe('First item');
    expect(r.level).toBe(3);
  });

  it('pr3 strips lowercase letter period prefix', () => {
    const r = classifyLine('a. lowercase item');
    expect(r.type).toBe('pr3');
    expect(r.text).toBe('lowercase item');
    expect(r.level).toBe(4);
  });

  it('pr4 strips numeric paren prefix', () => {
    const r = classifyLine('1) paren item');
    expect(r.type).toBe('pr4');
    expect(r.text).toBe('paren item');
    expect(r.level).toBe(5);
  });

  it('pr5 strips lowercase paren prefix', () => {
    const r = classifyLine('a) paren item');
    expect(r.type).toBe('pr5');
    expect(r.text).toBe('paren item');
    expect(r.level).toBe(6);
  });

  it('pr2 guard: digit-period at end of line is NOT pr2', () => {
    // KNOWN AMBIGUITY: "1." at line end with no following text — treated as continuation
    const r = classifyLine('1.');
    expect(r.type).toBe('continuation');
  });

  it('article guard: N.N requires whitespace and content', () => {
    // KNOWN AMBIGUITY: "1.1" with no following text — treated as continuation
    const r = classifyLine('1.1');
    expect(r.type).toBe('continuation');
  });

  it('indented line without prefix is continuation with indent level', () => {
    const r = classifyLine('    indented text'); // 4 spaces = level 1
    expect(r.type).toBe('continuation');
    expect(r.text).toBe('indented text');
    expect(r.level).toBe(1);
  });

  it('double-indented line has level 2', () => {
    const r = classifyLine('        double indent'); // 8 spaces
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(2);
  });

  it('tab indent treated as 4 spaces', () => {
    const r = classifyLine('\tTabbed line');
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(1);
  });

  it('unindented non-matching line is continuation at level -1', () => {
    const r = classifyLine('Plain prose with no prefix.');
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(-1);
  });

  it('SECTION header is case-insensitive', () => {
    const r = classifyLine('section 27 10 00 building cabling');
    expect(r.type).toBe('header');
  });

  it('PART heading with en-dash stripped correctly', () => {
    const r = classifyLine('PART 1 – GENERAL');
    expect(r.type).toBe('part');
    expect(r.text).toBe('GENERAL');
  });

  it('indent level 3 (12 spaces)', () => {
    const r = classifyLine('            triple indent');
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(3);
  });

  it('indent capped at level 6 (24+ spaces)', () => {
    const r = classifyLine('                        deep indent'); // 24 spaces
    expect(r.type).toBe('continuation');
    expect(r.level).toBe(6);
  });

  it('SECTION header with no title still classified as header', () => {
    const r = classifyLine('SECTION 03 30 00');
    expect(r.type).toBe('header');
  });
});
