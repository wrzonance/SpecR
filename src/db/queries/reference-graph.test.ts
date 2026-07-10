import { describe, it, expect } from 'vitest';
import { buildReferenceGraph, ANCHOR_CAP } from './reference-graph.js';
import type { GraphNodeInput, GraphRefRowInput } from './reference-graph.js';

const scope = { type: 'project', id: 'proj-1' } as const;

function node(specId: string, section: string, title = 't'): GraphNodeInput {
  return { specId, section, title };
}
function ref(
  sourceSpecId: string,
  targetSection: string,
  sourceParagraphId: string
): GraphRefRowInput {
  return { sourceSpecId, targetSection, sourceParagraphId };
}

describe('buildReferenceGraph', () => {
  it('marks a division umbrella node and derives division', () => {
    const g = buildReferenceGraph(scope, [node('u', '09 00 00'), node('a', '09 91 00')], [], {
      includeAnchors: false,
    });
    const umbrella = g.nodes.find((n) => n.specId === 'u');
    expect(umbrella).toMatchObject({ division: '09', isUmbrella: true });
    expect(g.nodes.find((n) => n.specId === 'a')).toMatchObject({
      division: '09',
      isUmbrella: false,
    });
  });

  it('resolves an in-scope edge and dangles an out-of-scope target', () => {
    const nodes = [node('a', '03 30 00'), node('b', '09 91 00')];
    const refs = [ref('a', '09 91 00', 'p1'), ref('a', '99 99 00', 'p2')];
    const g = buildReferenceGraph(scope, nodes, refs, { includeAnchors: false });
    const resolved = g.edges.find((e) => e.targetSection === '09 91 00');
    const dangling = g.edges.find((e) => e.targetSection === '99 99 00');
    expect(resolved?.targetSpecId).toBe('b');
    expect(dangling?.targetSpecId).toBeNull();
  });

  it('counts multiple citations of the same target as one edge', () => {
    const refs = [ref('a', '09 91 00', 'p1'), ref('a', '09 91 00', 'p2')];
    const g = buildReferenceGraph(scope, [node('a', '03 30 00'), node('b', '09 91 00')], refs, {
      includeAnchors: false,
    });
    const edge = g.edges.find((e) => e.sourceSpecId === 'a' && e.targetSection === '09 91 00');
    expect(edge?.citationCount).toBe(2);
    expect(edge?.anchors).toBeUndefined();
  });

  it('includes capped anchors and flags truncation when includeAnchors', () => {
    const refs = Array.from({ length: ANCHOR_CAP + 5 }, (_, i) => ref('a', '09 91 00', `p${i}`));
    const g = buildReferenceGraph(scope, [node('a', '03 30 00'), node('b', '09 91 00')], refs, {
      includeAnchors: true,
    });
    const edge = g.edges.find((e) => e.targetSection === '09 91 00');
    expect(edge?.citationCount).toBe(ANCHOR_CAP + 5);
    expect(edge?.anchors).toHaveLength(ANCHOR_CAP);
    expect(edge?.anchorsTruncated).toBe(true);
    expect(g.notes.some((n) => n.includes(String(ANCHOR_CAP)))).toBe(true);
  });

  it('reports umbrella present + subordinate not calling it out', () => {
    const nodes = [node('u', '09 00 00'), node('a', '09 91 00'), node('b', '09 22 00')];
    // a calls out the umbrella; b does not
    const refs = [ref('a', '09 00 00', 'p1')];
    const g = buildReferenceGraph(scope, nodes, refs, { includeAnchors: false });
    const div09 = g.umbrella.find((u) => u.division === '09');
    expect(div09?.umbrellaPresent).toBe(true);
    expect(div09?.umbrellaSpecId).toBe('u');
    expect(div09?.notCalledOut.map((s) => s.specId)).toEqual(['b']);
  });

  it('reports umbrella absent for a division with no {div} 00 00 node', () => {
    const g = buildReferenceGraph(scope, [node('a', '03 30 00')], [], { includeAnchors: false });
    const div03 = g.umbrella.find((u) => u.division === '03');
    expect(div03?.umbrellaPresent).toBe(false);
    expect(div03?.umbrellaSpecId).toBeNull();
  });
});
