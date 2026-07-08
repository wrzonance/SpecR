// src/parser/docx/hierarchy-confidence.test.ts
import { describe, expect, it } from 'vitest';
import { scoreHierarchyConfidence } from './hierarchy-confidence.js';
import type { SignalConflict, SignalNumber, SignalProvenance } from '../../ast/index.js';

const prov = (signalUsed: SignalNumber, agreed: SignalNumber[] = []): SignalProvenance => ({
  signalUsed,
  agreed,
});

const conflict = (
  signal: SignalNumber,
  reportedIlvl: number,
  reportedNodeType: SignalConflict['reportedNodeType']
): SignalConflict => ({ signal, reportedIlvl, reportedNodeType });

describe('scoreHierarchyConfidence', () => {
  it('null in → null out (unscored honesty)', () => {
    expect(scoreHierarchyConfidence(null, [], 'article')).toBeNull();
    expect(scoreHierarchyConfidence(undefined, [], 'article')).toBeNull();
  });

  it.each([
    [1, 0.95],
    [2, 0.85],
    [3, 0.6],
    [4, 0.6],
    [5, 0.35],
  ] as const)('base tier: signal %i alone scores %f', (signal, expected) => {
    const result = scoreHierarchyConfidence(prov(signal), [], 'article');
    expect(result?.confidence).toBeCloseTo(expected, 5);
  });

  it('corroboration bonus is weighted by the agreeing signal own tier and capped at 1.0', () => {
    // 0.95 + 0.15*0.85 = 1.0775 → clamp 1.0
    expect(scoreHierarchyConfidence(prov(1, [2]), [], 'article')?.confidence).toBe(1);
    // 0.6 + 0.15*0.35 = 0.6525
    expect(scoreHierarchyConfidence(prov(4, [5]), [], 'pr2')?.confidence).toBeCloseTo(0.6525, 5);
  });

  it('conflict penalty scales with ilvl distance (nodeType mismatch base + distance)', () => {
    // article = normalized 1. Conflict at ilvl 2 → 0.95 − (0.1 + 0.02·1) = 0.83
    const near = scoreHierarchyConfidence(prov(1), [conflict(4, 2, 'pr1')], 'article');
    // Conflict at ilvl 4 → 0.95 − (0.1 + 0.02·3) = 0.79
    const far = scoreHierarchyConfidence(prov(1), [conflict(4, 4, 'pr3')], 'article');
    expect(near?.confidence).toBeCloseTo(0.83, 5);
    expect(far?.confidence).toBeCloseTo(0.79, 5);
    expect(far!.confidence).toBeLessThan(near!.confidence);
  });

  it('clamps to 0 when penalties exceed the base', () => {
    const conflicts = [conflict(1, 5, 'pr4'), conflict(2, 5, 'pr4'), conflict(4, 5, 'pr4')];
    // 0.35 − 3·(0.1 + 0.02·3) = 0.35 − 0.48 → clamp 0  (indentation win at pr1=2)
    expect(scoreHierarchyConfidence(prov(5), conflicts, 'pr1')?.confidence).toBe(0);
  });

  it('monotonic in corroboration: adding an agreed signal never lowers the score', () => {
    const withoutAgreed = scoreHierarchyConfidence(prov(4), [conflict(1, 1, 'article')], 'pr2');
    const withAgreed = scoreHierarchyConfidence(prov(4, [5]), [conflict(1, 1, 'article')], 'pr2');
    expect(withAgreed!.confidence).toBeGreaterThanOrEqual(withoutAgreed!.confidence);
  });

  it('antitonic in disagreement: adding a conflict never raises the score', () => {
    const withoutConflict = scoreHierarchyConfidence(prov(2, [4]), [], 'article');
    const withConflict = scoreHierarchyConfidence(prov(2, [4]), [conflict(5, 3, 'pr2')], 'article');
    expect(withConflict!.confidence).toBeLessThanOrEqual(withoutConflict!.confidence);
  });

  it('score stays within [0, 1] across a broad input sweep', () => {
    const signals: SignalNumber[] = [1, 2, 3, 4, 5];
    for (const s of signals) {
      for (const agreed of [[], signals.filter((x) => x !== s)] as SignalNumber[][]) {
        for (const conflicts of [[], [conflict(3, 8, 'pr7'), conflict(5, 0, 'part')]]) {
          const r = scoreHierarchyConfidence(prov(s, agreed), conflicts, 'article');
          expect(r!.confidence).toBeGreaterThanOrEqual(0);
          expect(r!.confidence).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('evidence names signals, never vendors', () => {
    const r = scoreHierarchyConfidence(prov(5), [conflict(2, 2, 'pr1')], 'article');
    expect(r?.evidence.some((e) => e.includes('indentation'))).toBe(true);
    expect(r?.evidence.some((e) => e.includes('style chain disagreed: pr1 vs article'))).toBe(true);
    for (const line of r?.evidence ?? []) {
      expect(line.toLowerCase()).not.toMatch(/arcat|cpi|ufgs/);
    }
  });

  it('lone winner evidence: "won alone" + "no corroborating signal fired"', () => {
    const r = scoreHierarchyConfidence(prov(5), [], 'pr1');
    expect(r?.evidence).toEqual(['indentation won alone', 'no corroborating signal fired']);
  });

  it('corroborated evidence lists each agreeing signal', () => {
    const r = scoreHierarchyConfidence(prov(1, [2, 4]), [], 'article');
    expect(r?.evidence).toEqual([
      'classified by numbering.xml',
      'corroborated by style chain',
      'corroborated by text pattern',
    ]);
  });

  it('passes provenance through: signalUsed and agreed echo the input', () => {
    const r = scoreHierarchyConfidence(prov(2, [1, 4]), [], 'pr1');
    expect(r?.signalUsed).toBe(2);
    expect(r?.agreed).toEqual([1, 4]);
  });
});
