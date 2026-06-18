import { describe, it, expect } from 'vitest';
import { STYLE_NODE_TYPES, StylePropertiesSchema } from '../../ast/index.js';
import type { StyleProperties } from '../../ast/types.js';
import type { ClassifiedParagraph } from './types.js';
import { deriveTemplate } from './derive-template.js';
import {
  analyzeDocxStyles as fromParserBarrel,
  deriveTemplate as deriveFromBarrel,
} from '../index.js';

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
    isVanish,
  };
}

function makeStyleMap(
  entries: ReadonlyArray<readonly [string, StyleProperties]>
): ReadonlyMap<string, StyleProperties> {
  return new Map(entries.map(([k, v]) => [k, StylePropertiesSchema.parse(v)]));
}

// ─── Case 1: Unanimous consensus ─────────────────────────────────────────────

describe('deriveTemplate — unanimous consensus', () => {
  const props: StyleProperties = StylePropertiesSchema.parse({
    rPr: { sz: 20, b: true },
    pPr: { ind: { left: 720 } },
  });
  const effectiveStyles = makeStyleMap([['PR1', props]]);
  const classified = [para('pr1', 'PR1'), para('pr1', 'PR1'), para('pr1', 'PR1')];

  it('emits one rule for pr1 with the unanimous properties', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    const rule = rules.find((r) => r.nodeType === 'pr1');
    expect(rule).toBeDefined();
    expect(rule!.properties).toEqual(props);
  });

  it('all decisions are source:consensus with confidence 1 and no rejected', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'pr1');
    expect(nr).toBeDefined();
    for (const d of nr!.decisions) {
      expect(d.source).toBe('consensus');
      expect(d.confidence).toBe(1);
      expect(d.rejected).toEqual([]);
    }
  });
});

// ─── Case 2: Dominant + outlier rejected ─────────────────────────────────────

describe('deriveTemplate — dominant + outlier', () => {
  const propsMain: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 20 } });
  const propsBig: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 24 } });
  const effectiveStyles = makeStyleMap([
    ['PR1', propsMain],
    ['PR1Big', propsBig],
  ]);
  // 4× main + 1× big
  const classified = [
    para('pr1', 'PR1'),
    para('pr1', 'PR1'),
    para('pr1', 'PR1'),
    para('pr1', 'PR1'),
    para('pr1', 'PR1Big'),
  ];

  it('rule uses sz:20 (dominant value)', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    const rule = rules.find((r) => r.nodeType === 'pr1');
    expect(rule?.properties?.rPr?.sz).toBe(20);
  });

  it('rPr.sz decision: confidence 0.8, rejected contains sz:24 with count 1, disagreesWithIntent false', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'pr1')!;
    const d = nr.decisions.find((x) => x.path === 'rPr.sz');
    expect(d).toBeDefined();
    expect(d!.confidence).toBeCloseTo(0.8);
    expect(d!.rejected).toEqual([{ value: 24, count: 1 }]);
    expect(d!.disagreesWithIntent).toBe(false);
  });
});

// ─── Case 3: Split → intent wins ─────────────────────────────────────────────

describe('deriveTemplate — split, intent wins', () => {
  const propsA: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 20 } });
  const propsB: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 24 } });
  const effectiveStyles = makeStyleMap([
    ['A', propsA],
    ['B', propsB],
  ]);
  // A paragraphs first (A is modal)
  const classified = [para('pr1', 'A'), para('pr1', 'A'), para('pr1', 'B'), para('pr1', 'B')];

  it('rule uses sz:20 (modal style A intent)', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    const rule = rules.find((r) => r.nodeType === 'pr1');
    expect(rule?.properties?.rPr?.sz).toBe(20);
  });

  it('decision: source:intent, disagreesWithIntent:false, exact rejected + confidence', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'pr1')!;
    const d = nr.decisions.find((x) => x.path === 'rPr.sz')!;
    expect(d.source).toBe('intent');
    expect(d.disagreesWithIntent).toBe(false);
    expect(d.rejected).toEqual([{ value: 24, count: 2 }]);
    expect(d.confidence).toBe(0.5);
  });
});

// ─── Case 4: Absent wins → property omitted ───────────────────────────────────

describe('deriveTemplate — absent wins → omitted', () => {
  const propsIt: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 20, i: true } });
  const propsMain: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 20 } });
  const effectiveStyles = makeStyleMap([
    ['It', propsIt],
    ['PR1', propsMain],
  ]);
  // 1× It + 4× PR1 → i is absent in 4/5 = absent wins
  const classified = [
    para('pr1', 'It'),
    para('pr1', 'PR1'),
    para('pr1', 'PR1'),
    para('pr1', 'PR1'),
    para('pr1', 'PR1'),
  ];

  it('rule has rPr.sz but NO rPr.i', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    const rule = rules.find((r) => r.nodeType === 'pr1')!;
    expect(rule.properties.rPr?.sz).toBe(20);
    expect(rule.properties.rPr?.i).toBeUndefined();
  });

  it('no decision recorded for rPr.i', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'pr1')!;
    const iDecision = nr.decisions.find((x) => x.path === 'rPr.i');
    expect(iDecision).toBeUndefined();
  });
});

// ─── Case 5: n=1 → single source ─────────────────────────────────────────────

describe('deriveTemplate — n=1, source:single', () => {
  const props: StyleProperties = StylePropertiesSchema.parse({ rPr: { b: true, caps: true } });
  const effectiveStyles = makeStyleMap([['PRT', props]]);
  const classified = [para('part', 'PRT')];

  it('rule equals the only voter properties', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    const rule = rules.find((r) => r.nodeType === 'part')!;
    expect(rule.properties).toEqual(props);
  });

  it('all decisions are source:single', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'part')!;
    for (const d of nr.decisions) {
      expect(d.source).toBe('single');
    }
  });
});

// ─── Case 6: Vanish + unstyled excluded ──────────────────────────────────────

describe('deriveTemplate — vanish + unstyled exclusion', () => {
  const props: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 20 } });
  const effectiveStyles = makeStyleMap([['PR1', props]]);
  // 1 vanish (excluded from everything), 1 unstyled (counted in paragraphCount, no vote),
  // 2 styled voters
  const classified = [
    para('pr1', 'PR1', true), // isVanish — excluded, counted in vanishSkipped
    para('pr1'), // no styleId — counted in paragraphCount, no vote
    para('pr1', 'PR1'), // voter
    para('pr1', 'PR1'), // voter
  ];

  it('vanishSkipped === 1', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    expect(report.vanishSkipped).toBe(1);
  });

  it('paragraphCount === 3 (vanish excluded)', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'pr1')!;
    expect(nr.paragraphCount).toBe(3);
  });

  it('styledCount === 2', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const nr = report.nodeTypes.find((n) => n.nodeType === 'pr1')!;
    expect(nr.styledCount).toBe(2);
  });
});

// ─── Case 7: Skipped NodeTypes ────────────────────────────────────────────────

describe('deriveTemplate — skipped NodeTypes', () => {
  const props: StyleProperties = StylePropertiesSchema.parse({ rPr: { sz: 20 } });
  const effectiveStyles = makeStyleMap([['PR1', props]]);
  // Only pr1 paragraphs; note and continuation are non-styleable (ignored)
  const classified = [para('pr1', 'PR1'), para('note'), para('continuation')];

  it('emits exactly one rule (for pr1)', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    // Only pr1 has data; all emitted rules are StyleNodeType by contract
    expect(rules).toHaveLength(1);
    expect(rules[0]?.nodeType).toBe('pr1');
  });

  it('skippedNodeTypes contains the other styleable types', () => {
    const { report } = deriveTemplate(classified, effectiveStyles);
    const expected = STYLE_NODE_TYPES.filter((t) => t !== 'pr1');
    const cmp = (a: string, b: string) => a.localeCompare(b);
    expect([...report.skippedNodeTypes].sort(cmp)).toEqual([...expected].sort(cmp));
  });
});

// ─── Case 8: Schema validity + unknown OOXML key preserved ───────────────────

describe('deriveTemplate — unknown OOXML key preserved, schema valid', () => {
  // pBdrX is not in the known schema but is a valid JSON value → should pass catchall
  const props: StyleProperties = StylePropertiesSchema.parse({
    rPr: { sz: 20 },
    pBdrX: { top: 'single' },
  });
  const effectiveStyles = makeStyleMap([['PR1', props]]);
  const classified = [para('pr1', 'PR1'), para('pr1', 'PR1')];

  it('rule contains the unknown pBdrX key', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    const rule = rules.find((r) => r.nodeType === 'pr1')!;
    expect(rule.properties['pBdrX']).toEqual({ top: 'single' });
  });

  it('StylePropertiesSchema.parse does not throw for every emitted rule', () => {
    const { rules } = deriveTemplate(classified, effectiveStyles);
    for (const rule of rules) {
      expect(() => StylePropertiesSchema.parse(rule.properties)).not.toThrow();
    }
  });
});

// ─── Module barrel surface ────────────────────────────────────────────────────

describe('module barrel surface', () => {
  it('exposes analyzeDocxStyles + deriveTemplate via parser/index.js', () => {
    expect(typeof fromParserBarrel).toBe('function');
    expect(typeof deriveFromBarrel).toBe('function');
  });
});
