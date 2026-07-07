// Pins the semantics of the consensus-stats helpers (absentWins tie rule,
// selectWinner fallback 'mode' arm) through the public deriveTemplate API.
// Moved verbatim from derive-template.test.ts (#154).

import { describe, it, expect } from 'vitest';
import { StylePropertiesSchema } from '../../ast/index.js';
import type { StyleProperties } from '../../ast/types.js';
import type { ClassifiedParagraph } from './types.js';
import { deriveTemplate } from './derive-template.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function para(
  nodeType: ClassifiedParagraph['nodeType'],
  styleId?: string,
  isVanish = false
): ClassifiedParagraph {
  return {
    paragraph: { text: 'x', isVanish, ...(styleId ? { styleId } : {}) },
    resolvedIlvl: 0,
    nodeType,
    signalUsed: 1,
    conflicts: [],
    agreed: [],
    isVanish,
  };
}

function makeStyleMap(
  entries: ReadonlyArray<readonly [string, StyleProperties]>
): ReadonlyMap<string, StyleProperties> {
  return new Map(entries.map(([k, v]) => [k, StylePropertiesSchema.parse(v)]));
}

// ─── Absent TIE does NOT omit — falls through to intent ──────────────────────

describe('deriveTemplate — absent tie falls through', () => {
  it('absent TIE falls through to intent (does not omit) — §5 consistency-wins-else-intent', () => {
    const styles = makeStyleMap([
      ['A', StylePropertiesSchema.parse({ rPr: { sz: 20 } })],
      ['Bare', StylePropertiesSchema.parse({})],
    ]);
    // 2× A (sz:20) + 2× Bare (vote "absent" on rPr.sz) → tie 2v2:
    // absent did not STRICTLY win → share 0.5 not >0.5 → modal style A
    // (first-seen on equal counts) defines sz → intent keeps sz=20.
    const input = [para('pr1', 'A'), para('pr1', 'A'), para('pr1', 'Bare'), para('pr1', 'Bare')];
    const { rules, report } = deriveTemplate(input, styles);
    expect(rules[0]?.properties.rPr?.sz).toBe(20);
    const d = report.nodeTypes[0]?.decisions.find((x) => x.path === 'rPr.sz');
    expect(d?.source).toBe('intent');
    expect(d?.confidence).toBe(0.5);
  });
});

// ─── Fallback plain mode — low plurality, no intent, non-numeric ──────────────

describe('deriveTemplate — fallback mode arm (no majority, no intent, non-numeric)', () => {
  const styles = makeStyleMap([
    ['Plain', StylePropertiesSchema.parse({ rPr: { b: true } })],
    ['U1', StylePropertiesSchema.parse({ rPr: { u: 'single' } })],
    ['U2', StylePropertiesSchema.parse({ rPr: { u: 'double' } })],
    ['U3', StylePropertiesSchema.parse({ rPr: { u: 'dash' } })],
  ]);
  // Plain paragraphs first → modal=Plain (first-seen on equal counts) and Plain
  // does NOT define rPr.u → intent cannot fire at that path. rPr.u splits 2/2/2
  // (no >0.5 winner), absent=2 does not strictly beat any defined count, and the
  // values are strings → the waterfall genuinely reaches the final 'mode' arm.
  const classified = [
    para('pr1', 'Plain'),
    para('pr1', 'Plain'),
    para('pr1', 'U1'),
    para('pr1', 'U1'),
    para('pr1', 'U2'),
    para('pr1', 'U2'),
    para('pr1', 'U3'),
    para('pr1', 'U3'),
  ];

  it('chooses first-seen plurality value with source:mode and its true low share', () => {
    const { rules, report } = deriveTemplate(classified, styles);
    expect(rules[0]?.properties.rPr?.u).toBe('single');
    const nr = report.nodeTypes[0]!;
    expect(nr.modalStyleId).toBe('Plain');
    const d = nr.decisions.find((x) => x.path === 'rPr.u');
    expect(d?.source).toBe('mode');
    expect(d?.confidence).toBe(0.25); // 2 of 8 voters
    expect(d?.disagreesWithIntent).toBe(false); // modal style defines nothing at rPr.u
    expect(d?.rejected).toEqual([
      { value: 'double', count: 2 },
      { value: 'dash', count: 2 },
    ]);
  });
});
