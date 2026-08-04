import { describe, it, expect } from 'vitest';
import { resolveHiddenTxbxContentNodes } from './body-text-box-visibility.js';
import type { ObjectBlobNode } from '../../ast/index.js';

// Hand-built ObjectBlobNode fixtures (preserveOrder-mode shape) — no XML
// parsing needed for this module's unit tests, and no cross-import from
// body-objects.ts/its test helpers, per #515's isolation design.

function textNode(text: string): ObjectBlobNode {
  return { '#text': text };
}

function para(text: string): ObjectBlobNode {
  return { 'w:p': [{ 'w:r': [{ 'w:t': [textNode(text)] }] }] };
}

function txbxContent(text: string): ObjectBlobNode {
  return { 'w:txbxContent': [para(text)] };
}

// A drawing run wrapping one txbxContent boundary, nested a few levels deep
// (drawing > graphic > graphicData > wsp > txbx > txbxContent) — proves the
// depth-first walk isn't shallow-only.
function drawingRun(content: ObjectBlobNode): ObjectBlobNode {
  return {
    'w:r': [
      {
        'w:drawing': [{ 'a:graphic': [{ 'a:graphicData': [{ 'wps:txbx': [content] }] }] }],
      },
    ],
  };
}

// A hyperlink-wrapped drawing run — the shape #515's design specifically
// targets w:txbxContent-node identity to handle correctly (spike-proven
// necessary over a w:r-child-only design).
function hyperlinkDrawingRun(content: ObjectBlobNode): ObjectBlobNode {
  return { 'w:hyperlink': [drawingRun(content)] };
}

function hostParagraph(children: readonly ObjectBlobNode[]): ObjectBlobNode {
  return { 'w:p': children };
}

describe('resolveHiddenTxbxContentNodes: no boundaries found', () => {
  it('returns an empty set for a host paragraph with no txbxContent descendants', () => {
    const host = hostParagraph([para('plain text, no drawing')]);
    expect(resolveHiddenTxbxContentNodes(host, [])).toEqual(new Set());
  });
});

describe('resolveHiddenTxbxContentNodes: all-visible boxes', () => {
  it('returns an empty hidden set when every hiddenFlags entry is false', () => {
    const first = txbxContent('first box');
    const second = txbxContent('second box');
    const host = hostParagraph([drawingRun(first), drawingRun(second)]);

    const hidden = resolveHiddenTxbxContentNodes(host, [false, false]);

    expect(hidden.size).toBe(0);
  });
});

describe('resolveHiddenTxbxContentNodes: all-hidden boxes', () => {
  it('returns every boundary when every hiddenFlags entry is true', () => {
    const first = txbxContent('first box');
    const second = txbxContent('second box');
    const host = hostParagraph([drawingRun(first), drawingRun(second)]);

    const hidden = resolveHiddenTxbxContentNodes(host, [true, true]);

    expect(hidden.size).toBe(2);
    expect(hidden.has(first)).toBe(true);
    expect(hidden.has(second)).toBe(true);
  });
});

describe('resolveHiddenTxbxContentNodes: mixed hidden and visible boxes', () => {
  it('correlates each hiddenFlags entry to its boundary by document order, not text content', () => {
    const visible = txbxContent('visible box');
    const hidden = txbxContent('hidden box');
    const host = hostParagraph([drawingRun(visible), drawingRun(hidden)]);

    const hiddenSet = resolveHiddenTxbxContentNodes(host, [false, true]);

    expect(hiddenSet.has(visible)).toBe(false);
    expect(hiddenSet.has(hidden)).toBe(true);
  });

  it('finds a hyperlink-wrapped text box boundary correctly, same as a bare drawing run', () => {
    const plain = txbxContent('plain box');
    const wrapped = txbxContent('hyperlink-wrapped box');
    const host = hostParagraph([drawingRun(plain), hyperlinkDrawingRun(wrapped)]);

    const hiddenSet = resolveHiddenTxbxContentNodes(host, [false, true]);

    expect(hiddenSet.has(plain)).toBe(false);
    expect(hiddenSet.has(wrapped)).toBe(true);
  });
});

describe('resolveHiddenTxbxContentNodes: identity-preserved membership', () => {
  it('returns the exact same node references found in the tree, not deep-equal copies', () => {
    const box = txbxContent('identity check');
    const host = hostParagraph([drawingRun(box)]);

    const hidden = resolveHiddenTxbxContentNodes(host, [true]);

    // A structurally-equal but distinct object must NOT satisfy Set
    // membership — callers (transformChildren) key off reference identity.
    expect(hidden.has(txbxContent('identity check'))).toBe(false);
    expect(hidden.has(box)).toBe(true);
  });
});

describe('resolveHiddenTxbxContentNodes: hiddenFlags count mismatch fails closed', () => {
  it('treats every boundary as hidden when hiddenFlags has fewer entries than boundaries found', () => {
    const first = txbxContent('first box');
    const second = txbxContent('second box');
    const host = hostParagraph([drawingRun(first), drawingRun(second)]);

    // Only one flag for two boundaries — correlation is broken; fail closed.
    const hidden = resolveHiddenTxbxContentNodes(host, [false]);

    expect(hidden.size).toBe(2);
    expect(hidden.has(first)).toBe(true);
    expect(hidden.has(second)).toBe(true);
  });

  it('treats every boundary as hidden when hiddenFlags has more entries than boundaries found, even all-false', () => {
    const only = txbxContent('only box');
    const host = hostParagraph([drawingRun(only)]);

    // Three flags (all false) for one boundary — still a mismatch, still
    // fails closed rather than trusting the (uncorrelated) false values.
    const hidden = resolveHiddenTxbxContentNodes(host, [false, false, false]);

    expect(hidden.size).toBe(1);
    expect(hidden.has(only)).toBe(true);
  });
});
