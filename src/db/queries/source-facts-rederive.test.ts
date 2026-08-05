import { describe, it, expect } from 'vitest';
import { deriveNextSourceFacts } from './source-facts-rederive.js';
import type { SourceFacts } from '../../ast/index.js';

describe('deriveNextSourceFacts', () => {
  it('resolving a one-option bracket placeholder to plain text clears choiceTokens', () => {
    const existing: SourceFacts = {
      choiceTokens: [{ kind: 'bracket', options: ['insert value'], span: [0, 15] }],
    };
    const next = deriveNextSourceFacts(existing, 'the resolved value');
    expect(next.choiceTokens).toBeUndefined();
    expect('choiceTokens' in next).toBe(false);
  });

  it('re-derives choiceTokens from fresh adjacent-bracket-group text', () => {
    const existing: SourceFacts = {
      choiceTokens: [{ kind: 'angle', options: ['old'], span: [0, 5] }],
    };
    const next = deriveNextSourceFacts(existing, '<aluminum><steel>');
    expect(next.choiceTokens).toEqual([
      { kind: 'angle', options: ['aluminum', 'steel'], span: [0, 17] },
    ]);
  });

  it('unrelated source_facts keys survive a text edit byte-identical', () => {
    const existing: SourceFacts = {
      choiceTokens: [{ kind: 'bracket', options: ['insert value'], span: [0, 15] }],
      comments: [{ author: 'Jane', text: 'why here?', anchor: [0, 9], closed: false }],
      colors: [{ color: 'FF0000', coverage: 0.5, spans: [[0, 5]] }],
      highlights: [{ color: 'yellow', text: 'note', span: [0, 4] }],
      emphasis: [{ property: 'bold', value: true, expected: false, text: 'x', span: [0, 1] }],
      banner: '** SPECIAL NOTICE **',
    };
    const next = deriveNextSourceFacts(existing, 'resolved plain text');
    expect(next.comments).toEqual(existing.comments);
    expect(next.colors).toEqual(existing.colors);
    expect(next.highlights).toEqual(existing.highlights);
    expect(next.emphasis).toEqual(existing.emphasis);
    expect(next.banner).toBe(existing.banner);
  });

  it('never mutates the existing SourceFacts object passed in', () => {
    const existing: SourceFacts = {
      choiceTokens: [{ kind: 'bracket', options: ['insert value'], span: [0, 15] }],
      banner: 'keep me',
    };
    const snapshot = structuredClone(existing);
    deriveNextSourceFacts(existing, 'resolved');
    expect(existing).toEqual(snapshot);
  });

  it('an empty existing SourceFacts with no choice tokens in new text stays empty', () => {
    const next = deriveNextSourceFacts({}, 'plain text, no placeholders here');
    expect(next).toEqual({});
  });
});
