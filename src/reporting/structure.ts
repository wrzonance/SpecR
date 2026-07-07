import type { ComparisonParagraph } from './types.js';

/** Children grouped by parentId (`''` bucket = roots), each list sorted by the
 *  deterministic (position, id) order the loader already emits. */
function groupChildren(
  rows: readonly ComparisonParagraph[]
): ReadonlyMap<string, readonly ComparisonParagraph[]> {
  const byParent = new Map<string, ComparisonParagraph[]>();
  for (const row of rows) {
    const key = row.parentId ?? '';
    const bucket = byParent.get(key);
    if (bucket === undefined) byParent.set(key, [row]);
    else bucket.push(row);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return byParent;
}

/** Ordinal among same-nodeType siblings — mirrors render numbering, which advances
 *  only past same-tier (consumesNumber) siblings, so interleaved notes/continuations
 *  never shift a numbered node's slot (src/ast/labels.ts). */
function siblingOrdinal(
  siblings: readonly ComparisonParagraph[],
  node: ComparisonParagraph
): number {
  let ordinal = 0;
  for (const sib of siblings) {
    if (sib.id === node.id) return ordinal;
    if (sib.nodeType === node.nodeType) ordinal += 1;
  }
  return ordinal;
}

/** Map every paragraph id to its canonical structural address: the root-to-node
 *  path of `nodeType:ordinal` segments joined by `|`. Two structurally-identical
 *  trees produce identical strings for corresponding nodes, so the address is
 *  comparable across independently-ingested sources (no rendered label is stored
 *  or compared — numbering is render-derived; ADR-053). */
export function computeStructuralKeys(
  rows: readonly ComparisonParagraph[]
): ReadonlyMap<string, string> {
  const byParent = groupChildren(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, string>();

  const addressOf = (node: ComparisonParagraph): string => {
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    const siblings = byParent.get(node.parentId ?? '') ?? [];
    const segment = `${node.nodeType}:${siblingOrdinal(siblings, node)}`;
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    const address = parent === undefined ? segment : `${addressOf(parent)}|${segment}`;
    memo.set(node.id, address);
    return address;
  };

  return new Map(rows.map((r) => [r.id, addressOf(r)]));
}
