import { describe, it, expect } from 'vitest';
import { inferSectionMeta, computeTitleMatch } from './infer-section.js';
import type { CsiTree } from '../ast/types.js';

function makeTree(nodes: { text: string }[]): CsiTree {
  return {
    id: 'x',
    section: 'unknown',
    title: 'unknown',
    parts: nodes.map((n, i) => ({
      id: `node-${i}`,
      type: 'part' as const,
      text: n.text,
      children: [],
      meta: {},
    })),
  };
}

describe('inferSectionMeta', () => {
  it('returns method:metadata when section already set', () => {
    const tree: CsiTree = { id: 'x', section: '27 10 00', title: 'Telecom', parts: [] };
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('metadata');
    expect(result.confidence).toBe('high');
    expect(result.inferredSection).toBe('27 10 00');
    expect(result.inferredTitle).toBe('Telecom');
    expect(result.titleMatch).toBe('unknown');
  });

  it('level 1: finds SECTION keyword — confidence high', () => {
    const tree = makeTree([{ text: 'Preamble' }, { text: 'SECTION 26 09 33' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-high');
    expect(result.confidence).toBe('high');
    expect(result.inferredSection).toBe('26 09 33');
  });

  it('level 1: case-insensitive SECTION keyword', () => {
    const tree = makeTree([{ text: 'section 26 09 33' }]);
    expect(inferSectionMeta(tree).inferredSection).toBe('26 09 33');
  });

  it('level 1: extracts title from next node', () => {
    const tree = makeTree([
      { text: 'SECTION 26 09 33' },
      { text: 'VARIABLE FREQUENCY MOTOR CONTROLLERS' },
    ]);
    expect(inferSectionMeta(tree).inferredTitle).toBe('VARIABLE FREQUENCY MOTOR CONTROLLERS');
  });

  it('level 1: extracts inline title when on same line as section keyword', () => {
    const tree = makeTree([{ text: 'SECTION 26 09 33 VARIABLE FREQUENCY MOTOR CONTROLLERS' }]);
    const result = inferSectionMeta(tree);
    expect(result.inferredSection).toBe('26 09 33');
    expect(result.inferredTitle).toBe('VARIABLE FREQUENCY MOTOR CONTROLLERS');
  });

  it('level 1: skips blank nodes to find title', () => {
    const tree = makeTree([
      { text: 'SECTION 26 09 33' },
      { text: '' },
      { text: '   ' },
      { text: 'MOTOR CONTROLLERS' },
    ]);
    expect(inferSectionMeta(tree).inferredTitle).toBe('MOTOR CONTROLLERS');
  });

  it('level 1: finds title exactly 10 nodes after section node (boundary)', () => {
    const empties = Array.from({ length: 9 }, () => ({ text: '  ' }));
    const tree = makeTree([
      { text: 'SECTION 26 09 33' },
      ...empties,
      { text: 'MOTOR CONTROLLERS' },
    ]);
    // Node at offset +10 from section node — should be found
    expect(inferSectionMeta(tree).inferredTitle).toBe('MOTOR CONTROLLERS');
  });

  it('level 1: does NOT find title 11 nodes after section node (beyond window)', () => {
    const empties = Array.from({ length: 10 }, () => ({ text: '  ' }));
    const tree = makeTree([
      { text: 'SECTION 26 09 33' },
      ...empties,
      { text: 'MOTOR CONTROLLERS' },
    ]);
    // Node at offset +11 from section node — beyond window, title should be 'unknown'
    expect(inferSectionMeta(tree).inferredTitle).toBe('unknown');
  });

  it('level 2: bare number only — confidence medium', () => {
    const tree = makeTree([{ text: '26 09 33' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-medium');
    expect(result.confidence).toBe('medium');
    expect(result.inferredSection).toBe('26 09 33');
  });

  it('level 2: bare number embedded in sentence NOT matched', () => {
    const tree = makeTree([{ text: 'See paragraph 26 09 33 for details' }]);
    expect(inferSectionMeta(tree).confidence).toBe('none');
  });

  it('level 1 wins over level 2 when SECTION keyword found first', () => {
    const tree = makeTree([{ text: '26 09 33' }, { text: 'SECTION 27 10 00' }]);
    const result = inferSectionMeta(tree);
    expect(result.method).toBe('content-high');
    expect(result.inferredSection).toBe('27 10 00');
  });

  it('garbage preamble before SECTION line — found within 50 nodes', () => {
    const garbage = Array.from({ length: 40 }, (_, i) => ({ text: `garbage line ${i}` }));
    const tree = makeTree([...garbage, { text: 'SECTION 28 31 00' }]);
    const result = inferSectionMeta(tree);
    expect(result.confidence).toBe('high');
    expect(result.inferredSection).toBe('28 31 00');
  });

  it('returns none when SECTION line is beyond 50 nodes', () => {
    const garbage = Array.from({ length: 51 }, (_, i) => ({ text: `garbage ${i}` }));
    const tree = makeTree([...garbage, { text: 'SECTION 28 31 00' }]);
    expect(inferSectionMeta(tree).confidence).toBe('none');
  });

  it('returns none when nothing found', () => {
    const tree = makeTree([{ text: 'No section info here' }]);
    expect(inferSectionMeta(tree).confidence).toBe('none');
    expect(inferSectionMeta(tree).inferredSection).toBe('unknown');
  });

  it('returns none for empty tree — never throws', () => {
    const tree: CsiTree = { id: 'x', section: 'unknown', title: 'unknown', parts: [] };
    expect(() => inferSectionMeta(tree)).not.toThrow();
    expect(inferSectionMeta(tree).confidence).toBe('none');
  });
});

describe('computeTitleMatch', () => {
  it('exact match (same string)', () => {
    const { titleMatch, titleMatchScore } = computeTitleMatch(
      'Variable Frequency Motor Controllers',
      'Variable Frequency Motor Controllers'
    );
    expect(titleMatch).toBe('exact');
    expect(titleMatchScore).toBe(1);
  });

  it('exact match case-insensitive', () => {
    const { titleMatch } = computeTitleMatch(
      'VARIABLE FREQUENCY MOTOR CONTROLLERS',
      'Variable Frequency Motor Controllers'
    );
    expect(titleMatch).toBe('exact');
  });

  it('close match at or above 0.7', () => {
    const { titleMatch, titleMatchScore } = computeTitleMatch(
      'Variable Frequency Controllers',
      'Variable Frequency Motor Controllers'
    );
    expect(titleMatch).toBe('close');
    expect(titleMatchScore).toBeGreaterThanOrEqual(0.7);
  });

  it('divergent match below 0.7', () => {
    const { titleMatch } = computeTitleMatch('Fire Protection', 'Telecommunications');
    expect(titleMatch).toBe('divergent');
  });

  it('unknown when standardTitle is null', () => {
    const { titleMatch, titleMatchScore } = computeTitleMatch('Anything', null);
    expect(titleMatch).toBe('unknown');
    expect(titleMatchScore).toBeUndefined();
  });

  it('unknown when standardTitle is undefined', () => {
    const { titleMatch } = computeTitleMatch('Anything', undefined);
    expect(titleMatch).toBe('unknown');
  });
});
