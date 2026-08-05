import { describe, it, expect } from 'vitest';
import { deriveCommentClosureFacts } from './paragraph-comment-closure.js';
import type { SourceFacts } from '../../ast/index.js';

describe('deriveCommentClosureFacts', () => {
  it('closes the comment at the given index, leaving other keys untouched', () => {
    const facts: SourceFacts = {
      comments: [
        { author: 'A', text: 'first', anchor: [0, 5], closed: false },
        { author: 'B', text: 'second', anchor: [6, 12], closed: false },
      ],
      banner: 'keep me',
    };
    const next = deriveCommentClosureFacts(facts, 1, true);
    expect(next).toEqual({
      comments: [
        { author: 'A', text: 'first', anchor: [0, 5], closed: false },
        { author: 'B', text: 'second', anchor: [6, 12], closed: true },
      ],
      banner: 'keep me',
    });
  });

  it('returns null when there is no comments key', () => {
    expect(deriveCommentClosureFacts({}, 0, true)).toBeNull();
  });

  it('returns null when the index is out of range', () => {
    const facts: SourceFacts = {
      comments: [{ author: 'A', text: 'x', anchor: [0, 1], closed: false }],
    };
    expect(deriveCommentClosureFacts(facts, 5, true)).toBeNull();
  });

  it('never mutates the input facts object', () => {
    const facts: SourceFacts = {
      comments: [{ author: 'A', text: 'x', anchor: [0, 1], closed: false }],
    };
    const snapshot = structuredClone(facts);
    deriveCommentClosureFacts(facts, 0, true);
    expect(facts).toEqual(snapshot);
  });
});
