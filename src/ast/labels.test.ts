import { describe, it, expect } from 'vitest';
import { consumesNumber } from './labels.js';
import type { SpecNode, NodeType } from './types.js';

function node(type: NodeType, vanish = false): SpecNode {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    type,
    text: 'x',
    children: [],
    meta: { vanish },
  };
}

describe('consumesNumber — body object model (#300)', () => {
  it('object and objectText never consume a CSI ordinal', () => {
    expect(consumesNumber(node('object'))).toBe(false);
    expect(consumesNumber(node('objectText'))).toBe(false);
  });

  it('still excludes the pre-existing non-numbered types', () => {
    expect(consumesNumber(node('note'))).toBe(false);
    expect(consumesNumber(node('continuation'))).toBe(false);
    expect(consumesNumber(node('article', true))).toBe(false); // vanished
  });

  it('still consumes a number for ordinary structural types', () => {
    expect(consumesNumber(node('part'))).toBe(true);
    expect(consumesNumber(node('article'))).toBe(true);
    expect(consumesNumber(node('pr1'))).toBe(true);
  });
});
