import { describe, it, expect } from 'vitest';
import { namespaceVanishTrees } from './object-vanish-namespace.js';
import type { ObjectBlobNode, SpecNode, SpecTree } from '../ast/index.js';

// Minimal SpecNode/SpecTree builders — mirrors object-vanish-styles.test.ts's
// own local convention: this module only ever reads/rewrites
// `type`/`children`/`meta.object`, so every other field is an arbitrary
// valid placeholder.
function node(overrides: Partial<SpecNode> & Pick<SpecNode, 'type'>): SpecNode {
  return { id: 'n', text: '', children: [], meta: {}, ...overrides };
}

// Computed `['w:rStyle']` key (rather than a literal `'w:rStyle':` property)
// mirrors body-objects.test.ts's own established `attrNode` helper — the
// workaround for a TS limitation where a hand-assembled object literal can't
// satisfy ObjectBlobNode's index signature + intersected `:@` key at once
// when the tag is a literal property name.
function rStyleNode(styleId: string): ObjectBlobNode {
  const tag: string = 'w:rStyle';
  return { [tag]: [], ':@': { '@_w:val': styleId } } as ObjectBlobNode;
}

// A `w:tbl > ... > w:r` blob whose single run's `w:rPr > w:rStyle` names
// `styleId` — the exact shape `hasRunVanish`/generation consume — plus a
// text leaf so the object is non-empty capture data.
function tableBlobWithRStyle(styleId: string, text: string): ObjectBlobNode[] {
  return [
    {
      'w:tbl': [
        {
          'w:tr': [
            {
              'w:tc': [
                {
                  'w:p': [
                    {
                      'w:r': [{ 'w:rPr': [rStyleNode(styleId)] }, { 'w:t': [{ '#text': text }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function objectNode(
  styleId: string,
  text: string,
  vanishCharStyleIds?: readonly string[]
): SpecNode {
  return node({
    type: 'object',
    meta: {
      object: {
        kind: 'table',
        floating: false,
        generation: 'drawingml',
        blob: tableBlobWithRStyle(styleId, text),
        ...(vanishCharStyleIds !== undefined
          ? { vanishCharStyleIds: [...vanishCharStyleIds] }
          : {}),
      },
    },
  });
}

function tree(id: string, parts: readonly SpecNode[]): SpecTree {
  return { id, section: '00 00 00', title: 'Test', parts };
}

function rStyleVal(node1: ObjectBlobNode): string | undefined {
  const attrs = node1[':@'];
  return typeof attrs?.['@_w:val'] === 'string' ? attrs['@_w:val'] : undefined;
}

// Walks a captured blob's arbitrary node shape to find the (sole) w:rStyle
// node's own `@_w:val` — deliberately structure-agnostic (rather than a
// fixed-depth dig matching tableBlobWithRStyle exactly) so it stays correct
// if that fixture's own nesting ever changes shape.
function rStyleValOf(blob: readonly ObjectBlobNode[]): string | undefined {
  for (const child of blob) {
    const tag = Object.keys(child).find((key) => key !== ':@');
    if (!tag) continue;
    if (tag === 'w:rStyle') return rStyleVal(child);
    const value = child[tag];
    if (Array.isArray(value)) {
      const found = rStyleValOf(value);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

describe('namespaceVanishTrees', () => {
  it('returns the same array reference for zero trees', () => {
    const trees: SpecTree[] = [];
    expect(namespaceVanishTrees(trees)).toBe(trees);
  });

  it('returns the same array reference for a single tree, even with vanish ids', () => {
    const trees = [tree('t0', [objectNode('Hidden1', 'secret', ['Hidden1'])])];
    expect(namespaceVanishTrees(trees)).toBe(trees);
  });

  it('returns the same array reference when no tree in a multi-tree manual has any vanish ids', () => {
    const trees = [tree('t0', [node({ type: 'article' })]), tree('t1', [objectNode('X', 'y')])];
    expect(namespaceVanishTrees(trees)).toBe(trees);
  });

  it('leaves an individual tree untouched (by reference) when it has no vanish ids, even alongside a sibling that does', () => {
    const untouched = tree('t0', [objectNode('X', 'y')]);
    const withVanish = tree('t1', [objectNode('Hidden1', 'secret', ['Hidden1'])]);
    const result = namespaceVanishTrees([untouched, withVanish]);
    expect(result[0]).toBe(untouched);
    expect(result[1]).not.toBe(withVanish);
  });

  it('namespaces two trees that independently vanish DIFFERENT ids, one per tree', () => {
    const treeA = tree('a', [objectNode('Alpha', 'a-text', ['Alpha'])]);
    const treeB = tree('b', [objectNode('Beta', 'b-text', ['Beta'])]);
    const [resultA, resultB] = namespaceVanishTrees([treeA, treeB]);

    const objA = resultA?.parts[0];
    const objB = resultB?.parts[0];
    expect(objA?.meta.object?.vanishCharStyleIds).toEqual(['Alpha#specr-vanish-t0']);
    expect(objB?.meta.object?.vanishCharStyleIds).toEqual(['Beta#specr-vanish-t1']);
  });

  // The crux #650 review scenario: two DIFFERENT source documents that
  // happen to use the exact SAME raw character-style id string for
  // completely different purposes. Each tree's own copy of that id must end
  // up in its OWN private namespace — never sharing one id across trees,
  // which is what let one tree's vanish stub silently overwrite the other's
  // unrelated definition.
  it('gives colliding raw ids across two trees distinct, non-overlapping namespaced ids', () => {
    const treeA = tree('a', [objectNode('Hidden1', 'a-secret', ['Hidden1'])]);
    const treeB = tree('b', [objectNode('Hidden1', 'b-secret', ['Hidden1'])]);
    const [resultA, resultB] = namespaceVanishTrees([treeA, treeB]);

    const idsA = resultA?.parts[0]?.meta.object?.vanishCharStyleIds;
    const idsB = resultB?.parts[0]?.meta.object?.vanishCharStyleIds;
    expect(idsA).toEqual(['Hidden1#specr-vanish-t0']);
    expect(idsB).toEqual(['Hidden1#specr-vanish-t1']);
    expect(idsA?.[0]).not.toEqual(idsB?.[0]);
  });

  it('rewrites the blob’s own w:rStyle reference to match the renamed id', () => {
    const trees = [
      tree('a', [objectNode('X', 'y')]),
      tree('b', [objectNode('Hidden1', 'secret', ['Hidden1'])]),
    ];
    const [, resultB] = namespaceVanishTrees(trees);
    const blob = resultB?.parts[0]?.meta.object?.blob ?? [];
    expect(rStyleValOf(blob)).toBe('Hidden1#specr-vanish-t1');
  });

  it('does NOT rewrite a w:rStyle id that is referenced but not in this tree’s own vanishCharStyleIds', () => {
    // treeA's object references "Shared" purely for formatting — not vanish
    // in treeA at all (its own vanishCharStyleIds is undefined). treeB
    // separately vanishes "Shared". treeA's own reference must stay
    // untouched: it was never this tree's vanish id to rename.
    const treeA = tree('a', [objectNode('Shared', 'bold-but-visible')]);
    const treeB = tree('b', [objectNode('Shared', 'secret', ['Shared'])]);
    const [resultA, resultB] = namespaceVanishTrees([treeA, treeB]);

    const blobA = resultA?.parts[0]?.meta.object?.blob ?? [];
    const blobB = resultB?.parts[0]?.meta.object?.blob ?? [];
    expect(rStyleValOf(blobA)).toBe('Shared');
    expect(rStyleValOf(blobB)).toBe('Shared#specr-vanish-t1');
  });

  it('finds and namespaces an object node nested arbitrarily deep under non-object ancestors', () => {
    const deep = node({
      type: 'article',
      children: [objectNode('Deep', 'secret', ['Deep'])],
    });
    const trees = [tree('a', [objectNode('X', 'y')]), tree('b', [deep])];
    const [, resultB] = namespaceVanishTrees(trees);
    const nested = resultB?.parts[0]?.children[0];
    expect(nested?.meta.object?.vanishCharStyleIds).toEqual(['Deep#specr-vanish-t1']);
  });

  it('preserves node identity for siblings untouched by the rewrite', () => {
    const unrelatedSibling = node({ type: 'article', text: 'untouched' });
    const treeA = tree('a', [unrelatedSibling, objectNode('Hidden1', 'secret', ['Hidden1'])]);
    const treeB = tree('b', [objectNode('Hidden1', 'secret', ['Hidden1'])]);
    const [resultA] = namespaceVanishTrees([treeA, treeB]);
    expect(resultA?.parts[0]).toBe(unrelatedSibling);
  });
});
