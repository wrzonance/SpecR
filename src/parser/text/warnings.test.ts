import { describe, it, expect } from 'vitest';
import { parseText } from './index.js';

describe('parseText — anomaly warnings', () => {
  it('no-structure-found: empty doc → tree.warnings has no-structure-found, capabilities includes parse-warnings', () => {
    const result = parseText('');
    expect(result.tree.warnings).toBeDefined();
    expect(result.tree.warnings?.some((w) => w.type === 'no-structure-found')).toBe(true);
    expect(result.capabilities).toContain('parse-warnings');
  });

  it('no-structure-found: prose-only doc with no PART/article prefixes → no-structure-found warning', () => {
    const text = [
      'SECTION 09 91 00 - PAINTING',
      'This document contains only prose.',
      'There are no PART or article prefixes.',
      'It should not be misclassified.',
    ].join('\n');
    const result = parseText(text);
    expect(result.tree.warnings?.some((w) => w.type === 'no-structure-found')).toBe(true);
    expect(result.capabilities).toContain('parse-warnings');
  });

  it('empty-part: PART 1 followed immediately by PART 2 with content → empty-part warning on PART 1 with lineHint', () => {
    const text = [
      'SECTION 09 91 00 - PAINTING',
      'PART 1 - GENERAL',
      'PART 2 - PRODUCTS',
      '1.1 SCOPE',
      'Description of products.',
    ].join('\n');
    const result = parseText(text);
    const emptyPart = result.tree.warnings?.find((w) => w.type === 'empty-part');
    expect(emptyPart).toBeDefined();
    expect(emptyPart?.lineHint).toMatch(/^line \d+: /);
    expect(emptyPart?.lineHint).toContain('GENERAL');
    expect(result.capabilities).toContain('parse-warnings');
  });

  it('root-continuation: prose lines before first PART → root-continuation warning, dropped text appears in lineHint', () => {
    const text = [
      'SECTION 09 91 00 - PAINTING',
      '] orphan note bleed before any PART',
      'PART 1 - GENERAL',
      '1.1 SCOPE',
      'Hello.',
    ].join('\n');
    const result = parseText(text);
    const rootCont = result.tree.warnings?.find((w) => w.type === 'root-continuation');
    expect(rootCont).toBeDefined();
    expect(rootCont?.lineHint).toMatch(/^line \d+: /);
    expect(rootCont?.lineHint).toContain('orphan note bleed');
    expect(result.capabilities).toContain('parse-warnings');
  });

  it('root-continuation cap: 10 dropped lines → exactly 5 warnings emitted, all type=root-continuation', () => {
    const droppedLines = Array.from({ length: 10 }, (_, i) => `dropped continuation line ${i + 1}`);
    const text = [
      'SECTION 09 91 00 - PAINTING',
      ...droppedLines,
      'PART 1 - GENERAL',
      '1.1 SCOPE',
      'Hello.',
    ].join('\n');
    const result = parseText(text);
    const rootContWarnings =
      result.tree.warnings?.filter((w) => w.type === 'root-continuation') ?? [];
    expect(rootContWarnings).toHaveLength(5);
    expect(rootContWarnings.every((w) => w.type === 'root-continuation')).toBe(true);
  });

  it('no anomalies: well-formed UFGS structure → tree.warnings undefined, capabilities does NOT include parse-warnings', () => {
    const text = [
      'SECTION 09 91 00 - PAINTING',
      'PART 1 - GENERAL',
      '1.1 SCOPE',
      'Hello.',
      'PART 2 - PRODUCTS',
      '2.1 MATERIALS',
      'Product description.',
      'PART 3 - EXECUTION',
      '3.1 INSTALLATION',
      'Installation steps.',
    ].join('\n');
    const result = parseText(text);
    expect(result.tree.warnings).toBeUndefined();
    expect(result.capabilities).not.toContain('parse-warnings');
  });

  it('capabilities array unchanged on no-anomaly path (still ["read-only"])', () => {
    const text = [
      'SECTION 09 91 00 - PAINTING',
      'PART 1 - GENERAL',
      '1.1 SCOPE',
      'Hello.',
      'PART 2 - PRODUCTS',
      '2.1 MATERIALS',
      'Materials.',
      'PART 3 - EXECUTION',
      '3.1 INSTALLATION',
      'Install.',
    ].join('\n');
    const result = parseText(text);
    expect(result.capabilities).toEqual(['read-only']);
  });
});
