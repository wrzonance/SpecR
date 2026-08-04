import { describe, it, expect } from 'vitest';
import {
  collectVanishCharacterStyleIds,
  vanishCharacterStyleOptions,
} from './object-vanish-styles.js';
import type { SpecNode, SpecTree } from '../ast/index.js';

// Minimal SpecNode/SpecTree builders — this module only ever reads
// `type`/`children`/`meta.object?.vanishCharStyleIds`, so every other field
// is filled with an arbitrary valid placeholder.
function node(overrides: Partial<SpecNode> & Pick<SpecNode, 'type'>): SpecNode {
  return { id: 'n', text: '', children: [], meta: {}, ...overrides };
}

function objectNode(vanishCharStyleIds?: readonly string[]): SpecNode {
  return node({
    type: 'object',
    meta: {
      object: {
        kind: 'table',
        floating: false,
        generation: 'drawingml',
        blob: [{ 'w:tbl': [] }],
        ...(vanishCharStyleIds !== undefined
          ? { vanishCharStyleIds: [...vanishCharStyleIds] }
          : {}),
      },
    },
  });
}

function tree(parts: readonly SpecNode[]): SpecTree {
  return { id: 't', section: '00 00 00', title: 'Test', parts };
}

describe('collectVanishCharacterStyleIds', () => {
  it('returns an empty array when no tree has any object node', () => {
    expect(collectVanishCharacterStyleIds([tree([node({ type: 'article' })])])).toEqual([]);
  });

  it('returns an empty array when an object node carries no vanishCharStyleIds', () => {
    expect(collectVanishCharacterStyleIds([tree([objectNode()])])).toEqual([]);
  });

  it('returns an empty array when an object node carries an empty vanishCharStyleIds', () => {
    expect(collectVanishCharacterStyleIds([tree([objectNode([])])])).toEqual([]);
  });

  it('collects a single object node’s ids', () => {
    expect(collectVanishCharacterStyleIds([tree([objectNode(['HiddenChar'])])])).toEqual([
      'HiddenChar',
    ]);
  });

  it('dedupes ids repeated across multiple object nodes and returns them sorted', () => {
    const trees = [tree([objectNode(['Zeta', 'HiddenChar']), objectNode(['HiddenChar'])])];
    expect(collectVanishCharacterStyleIds(trees)).toEqual(['HiddenChar', 'Zeta']);
  });

  it('finds an object node nested arbitrarily deep under non-object ancestors', () => {
    const nested = node({ type: 'article', children: [objectNode(['Deep'])] });
    expect(collectVanishCharacterStyleIds([tree([nested])])).toEqual(['Deep']);
  });

  it('collects across multiple trees (a manual’s multiple sections)', () => {
    const trees = [tree([objectNode(['A'])]), tree([objectNode(['B'])])];
    expect(collectVanishCharacterStyleIds(trees)).toEqual(['A', 'B']);
  });
});

describe('vanishCharacterStyleOptions', () => {
  it('returns an empty array for no ids', () => {
    expect(vanishCharacterStyleOptions([])).toEqual([]);
  });

  it('builds one enabled-vanish character style option per id, name mirroring id', () => {
    expect(vanishCharacterStyleOptions(['HiddenChar', 'Other'])).toEqual([
      { id: 'HiddenChar', name: 'HiddenChar', run: { vanish: true } },
      { id: 'Other', name: 'Other', run: { vanish: true } },
    ]);
  });
});
