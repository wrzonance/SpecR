import { describe, it, expect } from 'vitest';
import { nestLeadInSublists } from './lead-in-nesting.js';
import type { ClassifiedParagraph, SignalConflict, SignalId } from './types.js';
import type { NodeType } from '../../ast/types.js';

// Normalized ilvl tiers used throughout (part=0, article=1, pr1=2, pr2=3, pr3=4).
const ARTICLE = 1;
const PR1 = 2;
const PR2 = 3;
const PR3 = 4;

function cp(
  text: string,
  resolvedIlvl: number,
  nodeType: NodeType,
  signalUsed: SignalId,
  conflicts: readonly SignalConflict[] = []
): ClassifiedParagraph {
  return {
    paragraph: { text, isVanish: false },
    resolvedIlvl,
    nodeType,
    signalUsed,
    conflicts,
    agreed: [],
    isVanish: false,
  };
}

// A REFERENCES-shaped scenario: an article, an indented (Signal-5) lead-in, and a
// Signal-4 restart sub-list at the SAME resolved tier as the lead-in.
function scenario(leadInText: string, markers: readonly string[]): ClassifiedParagraph[] {
  return [
    cp('REFERENCES', ARTICLE, 'article', 4),
    cp(leadInText, PR2, 'pr2', 5),
    ...markers.map((m) =>
      cp(m, PR2, 'pr2', 4, [{ signal: 5, reportedIlvl: PR3, reportedNodeType: 'pr3' }])
    ),
  ];
}

describe('nestLeadInSublists', () => {
  it('invariant 1: Signal-5 lead-in colliding with a following Signal-4 restart run is promoted to T−1', () => {
    const input = scenario('Abbreviations and Acronyms:', ['1.\ta', '2.\tb']);
    const out = nestLeadInSublists(input);
    const lead = out[1];
    expect(lead?.resolvedIlvl).toBe(PR1);
    expect(lead?.nodeType).toBe('pr1');
    expect(lead?.signalUsed).toBe(5); // provenance preserved; promotion is an overlay
  });

  it('invariant 1: the Signal-4 run stays at T (nests under the promoted lead-in via buildTree)', () => {
    const input = scenario('Definitions:', ['1.\tNETA', '2.\tICEA']);
    const out = nestLeadInSublists(input);
    expect(out[2]?.resolvedIlvl).toBe(PR2);
    expect(out[3]?.resolvedIlvl).toBe(PR2);
  });

  it('invariant 2: no collision — a sub-list already deeper than the lead-in is untouched', () => {
    const input = [
      cp('REFERENCES', ARTICLE, 'article', 4),
      cp('Abbreviations:', PR2, 'pr2', 5),
      cp('1.\ta', PR3, 'pr3', 4), // already one tier deeper — buildTree nests it already
    ];
    const out = nestLeadInSublists(input);
    expect(out[1]?.resolvedIlvl).toBe(PR2);
    expect(out[1]?.nodeType).toBe('pr2');
  });

  it('invariant 3: restart marker not ordinal 1 (outer-sequence continuation) is untouched', () => {
    const input = scenario('Continued list:', ['6.\tf', '7.\tg']);
    const out = nestLeadInSublists(input);
    expect(out[1]?.resolvedIlvl).toBe(PR2);
  });

  // KNOWN AMBIGUITY: the lead-in's structural parent already sits at T−1, so
  // promoting would make the lead-in a sibling of its own parent tier. No room →
  // skip; the mixed scheme is left as-is rather than silently guessing.
  it('invariant 4: no promotion room (parent already at T−1) is untouched — KNOWN AMBIGUITY', () => {
    const input = [
      cp('REFERENCES', ARTICLE, 'article', 4),
      cp('A. Parent', PR1, 'pr1', 4),
      cp('Lead-in:', PR2, 'pr2', 5),
      cp('1.\ta', PR2, 'pr2', 4),
      cp('2.\tb', PR2, 'pr2', 4),
    ];
    const out = nestLeadInSublists(input);
    expect(out[2]?.resolvedIlvl).toBe(PR2);
    expect(out[2]?.nodeType).toBe('pr2');
  });

  it('invariant 5: colon present fires on a single-item run', () => {
    const input = scenario('Definitions:', ['1.\tonly']);
    const out = nestLeadInSublists(input);
    expect(out[1]?.resolvedIlvl).toBe(PR1);
  });

  it('invariant 5: colon absent requires ≥2 restart items — single item untouched', () => {
    const input = scenario('Definitions', ['1.\tonly']); // no trailing colon
    const out = nestLeadInSublists(input);
    expect(out[1]?.resolvedIlvl).toBe(PR2);
  });

  it('invariant 5: colon absent with ≥2 restart items is promoted', () => {
    const input = scenario('Definitions', ['1.\ta', '2.\tb']); // no colon, run of 2
    const out = nestLeadInSublists(input);
    expect(out[1]?.resolvedIlvl).toBe(PR1);
  });

  it('invariant 6: promoted lead-in records its original tier as a conflict (never dropped)', () => {
    const input = scenario('Abbreviations:', ['1.\ta', '2.\tb']);
    const out = nestLeadInSublists(input);
    expect(out[1]?.conflicts).toContainEqual({
      signal: 5,
      reportedIlvl: PR2,
      reportedNodeType: 'pr2',
    });
  });

  it('a Signal-4 lead-in (its own typed label) is never a candidate — would double-label if promoted', () => {
    const input = [
      cp('REFERENCES', ARTICLE, 'article', 4),
      cp('1.\tGroup:', PR2, 'pr2', 4), // Signal-4, carries a typed "1." label of its own
      cp('1.\ta', PR2, 'pr2', 4),
      cp('2.\tb', PR2, 'pr2', 4),
    ];
    const out = nestLeadInSublists(input);
    expect(out[1]?.resolvedIlvl).toBe(PR2);
  });

  it('is pure: returns a new array, leaves input objects unmutated, reuses unchanged references', () => {
    const input = scenario('Abbreviations:', ['1.\ta', '2.\tb']);
    const out = nestLeadInSublists(input);
    expect(out).not.toBe(input);
    expect(input[1]?.resolvedIlvl).toBe(PR2); // input lead-in untouched
    expect(out[0]).toBe(input[0]); // unchanged entries reused by reference
    expect(out[2]).toBe(input[2]);
  });
});
