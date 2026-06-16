import { describe, expect, it } from 'vitest';
import { classify } from './classify.js';
import type { ConventionRules, SourceFacts, SpecNode, SpecTree } from '../ast/index.js';

// ── Builders ────────────────────────────────────────────────────────────────
// Minimal SpecNode/SpecTree factories so each test states only what it varies.

let idSeq = 0;
const nextId = (): string => `00000000-0000-0000-0000-${String(++idSeq).padStart(12, '0')}`;

function node(text: string, sourceFacts?: SourceFacts, children: SpecNode[] = []): SpecNode {
  return {
    id: nextId(),
    type: 'pr1',
    text,
    children,
    meta: sourceFacts === undefined ? {} : { sourceFacts },
  };
}

// A no-facts parent node (avoids a positional `undefined` for sourceFacts).
function branch(text: string, children: SpecNode[]): SpecNode {
  return { id: nextId(), type: 'pr1', text, children, meta: {} };
}

function tree(parts: SpecNode[]): SpecTree {
  return { id: nextId(), section: '09 91 23', title: 'Painting', parts };
}

// Classify a single paragraph and return its sole result.
function classifyOne(
  facts: SourceFacts | undefined,
  rules: ConventionRules
): {
  readonly editability: string;
  readonly confidence: number;
  readonly evidence: readonly { readonly rule: string; readonly fact?: string }[];
} {
  const result = classify(tree([node('Body text.', facts)]), rules);
  expect(result).toHaveLength(1);
  const [only] = result;
  if (only === undefined) throw new Error('expected one classification');
  return only;
}

const BLUE = '0000FF';
const blueColors = [{ color: BLUE, coverage: 1, spans: [[0, 10]] as const }];
const fullyBlue: SourceFacts = { colors: blueColors };

// ── Rung 5: default fallthrough ───────────────────────────────────────────────

describe('classify — default fallthrough', () => {
  it('no facts → defaultEditability with default-rule evidence', () => {
    const out = classifyOne(undefined, { defaultEditability: 'editable' });
    expect(out.editability).toBe('editable');
    expect(out.evidence[0]?.rule).toBe('defaultEditability');
  });

  it('no facts and no defaultEditability → locked (closed-vocabulary default)', () => {
    const out = classifyOne(undefined, {});
    expect(out.editability).toBe('locked');
    expect(out.evidence[0]?.rule).toBe('defaultEditability');
  });
});

// ── Rung 4: color meanings ────────────────────────────────────────────────────

describe('classify — color meanings rung', () => {
  const rules: ConventionRules = {
    colorMeanings: [{ color: BLUE, meaning: 'editable' }],
    defaultEditability: 'locked',
  };

  it('full-coverage blue with a colorMeanings entry → editable, high confidence', () => {
    const out = classifyOne(fullyBlue, rules);
    expect(out.editability).toBe('editable');
    expect(out.confidence).toBeGreaterThanOrEqual(0.9);
    expect(out.evidence[0]?.rule).toBe(`colorMeanings[${BLUE}]`);
    expect(out.evidence[0]?.fact).toBe('colors[0]');
  });

  it('AC: color present but NO colorMeanings entry → falls through to default, evidence says so', () => {
    const out = classifyOne(fullyBlue, { defaultEditability: 'locked' });
    expect(out.editability).toBe('locked');
    expect(out.evidence[0]?.rule).toBe('defaultEditability');
  });

  it('partial coverage yields lower confidence than full coverage', () => {
    const sparse: SourceFacts = { colors: [{ color: BLUE, coverage: 0.1, spans: [[0, 1]] }] };
    const full = classifyOne(fullyBlue, rules);
    const partial = classifyOne(sparse, rules);
    expect(partial.editability).toBe('editable');
    expect(partial.confidence).toBeLessThan(full.confidence);
  });

  it('highest-coverage matching color wins when several have meanings', () => {
    const rulesTwo: ConventionRules = {
      colorMeanings: [
        { color: BLUE, meaning: 'editable' },
        { color: 'FF0000', meaning: 'choice' },
      ],
      defaultEditability: 'locked',
    };
    const facts: SourceFacts = {
      colors: [
        { color: 'FF0000', coverage: 0.2, spans: [[0, 2]] },
        { color: BLUE, coverage: 0.8, spans: [[2, 10]] },
      ],
    };
    const out = classifyOne(facts, rulesTwo);
    expect(out.editability).toBe('editable');
    expect(out.evidence[0]?.rule).toBe(`colorMeanings[${BLUE}]`);
  });

  it('color: equal-coverage tie resolves to first occurrence in colors[]', () => {
    const rulesTwo: ConventionRules = {
      colorMeanings: [
        { color: 'FF0000', meaning: 'choice' },
        { color: BLUE, meaning: 'editable' },
      ],
      defaultEditability: 'locked',
    };
    const facts: SourceFacts = {
      colors: [
        { color: 'FF0000', coverage: 0.5, spans: [[0, 5]] },
        { color: BLUE, coverage: 0.5, spans: [[5, 10]] },
      ],
    };
    const out = classifyOne(facts, rulesTwo);
    expect(out.editability).toBe('choice');
    expect(out.evidence[0]?.rule).toBe('colorMeanings[FF0000]');
    expect(out.evidence[0]?.fact).toBe('colors[0]');
  });
});

// ── Rung 3: choice tokens ─────────────────────────────────────────────────────

describe('classify — choice rung', () => {
  const tokenFacts: SourceFacts = {
    choiceTokens: [{ kind: 'angle', options: ['epoxy', 'urethane'], span: [0, 20] }],
  };

  it('AC: choice token classifies choice ONLY when the profile enables that grammar', () => {
    const enabled = classifyOne(tokenFacts, { choiceTokens: [{ kind: 'angle' }] });
    expect(enabled.editability).toBe('choice');
    expect(enabled.evidence[0]?.rule).toBe('choiceTokens[angle]');
    expect(enabled.evidence[0]?.fact).toBe('choiceTokens[0]');
  });

  it('token kind not enabled → falls through (default here)', () => {
    const out = classifyOne(tokenFacts, {
      choiceTokens: [{ kind: 'bracket' }],
      defaultEditability: 'locked',
    });
    expect(out.editability).toBe('locked');
    expect(out.evidence[0]?.rule).toBe('defaultEditability');
  });

  it('choice outranks a color meaning on the same paragraph', () => {
    const both: SourceFacts = { ...tokenFacts, colors: blueColors };
    const out = classifyOne(both, {
      choiceTokens: [{ kind: 'angle' }],
      colorMeanings: [{ color: BLUE, meaning: 'editable' }],
    });
    expect(out.editability).toBe('choice');
  });
});

// ── Rung 2: comment policy ────────────────────────────────────────────────────

describe('classify — comment policy rung', () => {
  const commentFacts: SourceFacts = {
    comments: [{ author: 'JDoe', text: 'Verify with owner', anchor: [0, 4] }],
  };

  it('comment + comments.treatAs=note → note', () => {
    const out = classifyOne(commentFacts, { comments: { treatAs: 'note' } });
    expect(out.editability).toBe('note');
    expect(out.evidence[0]?.rule).toBe('comments');
    expect(out.evidence[0]?.fact).toBe('comments[0]');
  });

  it('comment policy outranks an enabled choice token', () => {
    const both: SourceFacts = {
      ...commentFacts,
      choiceTokens: [{ kind: 'angle', options: ['a', 'b'], span: [0, 4] }],
    };
    const out = classifyOne(both, {
      comments: { treatAs: 'editable' },
      choiceTokens: [{ kind: 'angle' }],
    });
    expect(out.editability).toBe('editable');
    expect(out.evidence[0]?.rule).toBe('comments');
  });

  it('comments present but no comments policy → falls through', () => {
    const out = classifyOne(commentFacts, { defaultEditability: 'locked' });
    expect(out.editability).toBe('locked');
  });
});

// ── Rung 1: note (top precedence) ─────────────────────────────────────────────

describe('classify — note rung (highest precedence)', () => {
  it('AC: banner fact present AND fully blue (editable color) → note (banner wins)', () => {
    const facts: SourceFacts = { banner: 'NOTES TO SPECIFIER', colors: blueColors };
    const out = classifyOne(facts, {
      colorMeanings: [{ color: BLUE, meaning: 'editable' }],
    });
    expect(out.editability).toBe('note');
    expect(out.evidence[0]?.rule).toBe('banner');
    expect(out.evidence[0]?.fact).toBe('banner');
  });

  it('noteBanners regex match on node text → note', () => {
    const result = classify(tree([node('SPECIFIER NOTE: choose one')]), {
      noteBanners: ['^SPECIFIER NOTE'],
    });
    expect(result[0]?.editability).toBe('note');
    expect(result[0]?.evidence[0]?.rule).toBe('noteBanners[0]');
  });

  it('invalid regex source is skipped — engine stays pure, no throw', () => {
    const badRules: ConventionRules = { noteBanners: ['('], defaultEditability: 'locked' };
    expect(() => classify(tree([node('Body.')]), badRules)).not.toThrow();
    const out = classify(tree([node('Body.')]), badRules);
    expect(out[0]?.editability).toBe('locked');
  });

  it('banner outranks comment policy', () => {
    const facts: SourceFacts = {
      banner: 'NOTES TO SPECIFIER',
      comments: [{ author: 'A', text: 'x', anchor: [0, 1] }],
    };
    const out = classifyOne(facts, { comments: { treatAs: 'editable' } });
    expect(out.editability).toBe('note');
  });
});

// ── Purity + tree walk ────────────────────────────────────────────────────────

describe('classify — purity and tree walk', () => {
  const rules: ConventionRules = {
    colorMeanings: [{ color: BLUE, meaning: 'editable' }],
    defaultEditability: 'locked',
  };

  it('AC: same inputs → deep-equal outputs across two calls (deterministic, no I/O)', () => {
    const t = tree([
      node('a', fullyBlue, [node('a.1')]),
      node('b', { banner: 'NOTES TO SPECIFIER' }),
    ]);
    const first = classify(t, rules);
    const second = classify(t, rules);
    expect(second).toEqual(first);
  });

  it('every node at every depth is classified, in pre-order', () => {
    const t = tree([
      branch('part', [
        node('child-blue', fullyBlue),
        branch('child-default', [node('grandchild', { banner: 'NOTES TO SPECIFIER' })]),
      ]),
    ]);
    const out = classify(t, rules);
    expect(out.map((c) => c.editability)).toEqual(['locked', 'editable', 'locked', 'note']);
    expect(out).toHaveLength(4);
  });

  it('does not mutate its inputs', () => {
    const facts: SourceFacts = { colors: [{ color: BLUE, coverage: 1, spans: [[0, 10]] }] };
    const t = tree([node('x', facts)]);
    const snapshot = JSON.stringify(t);
    classify(t, rules);
    expect(JSON.stringify(t)).toBe(snapshot);
  });
});
