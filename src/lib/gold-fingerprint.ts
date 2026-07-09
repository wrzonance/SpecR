// src/lib/gold-fingerprint.ts
import type { NodeType, SecRef, SpecNode, SpecTree } from '../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../ast/index.js';
import { fixtureRecord } from './fixture-snapshot.js';
import { buildHierarchyReport } from './hierarchy-report.js';
import { HIERARCHY_REVIEW_THRESHOLD } from './hierarchy-summary.js';

/** Below this confidence a scored paragraph lands in the `low` band; `[LOW, THRESHOLD)`
 *  is `review`; `>= THRESHOLD` is `high`. Coarser than a raw score so benign jitter
 *  never forces a re-bless. */
export const LOW_CONFIDENCE_BAND = 0.3;

// The renderers' skip-set — no normalized ilvl, never counted (mirrors
// hierarchy-summary.ts / the markdown renderer).
const NON_STRUCTURAL = new Set<NodeType>(['spec', 'note', 'continuation']);

export interface ConfidenceBands {
  readonly high: number;
  readonly review: number;
  readonly low: number;
}

export interface GoldFingerprint {
  readonly section: string;
  readonly parts: number;
  readonly noteLeaks: number;
  readonly maxDepth: number;
  readonly partShape: readonly (readonly number[])[];
  readonly confidenceBands: ConfidenceBands;
}

export interface FingerprintDelta {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

// Tally structural, non-vanish descendants of `node` (inclusive) into `counts`,
// indexed by normalized ilvl. Prunes vanish subtrees and skips non-structural types.
function bucketByIlvl(node: SpecNode, counts: number[]): void {
  if (node.meta.vanish === true) return;
  if (!NON_STRUCTURAL.has(node.type)) {
    const ilvl = nodeTypeToNormalizedIlvl(node.type);
    counts[ilvl] = (counts[ilvl] ?? 0) + 1;
  }
  for (const child of node.children) bucketByIlvl(child, counts);
}

function trimTrailingZeros(counts: readonly number[]): number[] {
  let end = counts.length;
  while (end > 0 && (counts[end - 1] ?? 0) === 0) end -= 1;
  return counts.slice(0, end);
}

// Per-part shape = descendant counts by ilvl BELOW the part (index 0 = articles,
// index 1 = pr1, …), trailing zeros trimmed. counts[0] is the part itself → dropped.
function partShapeOf(part: SpecNode): number[] {
  const counts: number[] = [];
  bucketByIlvl(part, counts);
  return trimTrailingZeros(counts.slice(1));
}

function maxDepthOf(tree: SpecTree): number {
  const counts: number[] = [];
  for (const part of tree.parts) bucketByIlvl(part, counts);
  return trimTrailingZeros(counts).length - 1; // highest ilvl present; -1 if none
}

function computeBands(tree: SpecTree): ConfidenceBands {
  const { paragraphs } = buildHierarchyReport(tree, null);
  let high = 0;
  let review = 0;
  let low = 0;
  for (const p of paragraphs) {
    if (p.confidence < LOW_CONFIDENCE_BAND) low += 1;
    else if (p.confidence < HIERARCHY_REVIEW_THRESHOLD) review += 1;
    else high += 1;
  }
  return { high, review, low };
}

function visibleParts(tree: SpecTree): SpecNode[] {
  return tree.parts.filter((n) => n.type === 'part' && n.meta.vanish !== true);
}

/**
 * Coarse structural + confidence-band fingerprint of a parsed spec (WS3, #426).
 * Pure — no I/O. Reuses `fixtureRecord` for the parts/note-leak facts and
 * `buildHierarchyReport` for the confidence bands so it can never drift from the
 * renderers or the WS2 scoring report.
 */
export function computeFingerprint(tree: SpecTree, refs: readonly SecRef[]): GoldFingerprint {
  const { parts, noteLeaks } = fixtureRecord(tree, refs);
  return {
    section: tree.section,
    parts,
    noteLeaks,
    maxDepth: maxDepthOf(tree),
    partShape: visibleParts(tree).map(partShapeOf),
    confidenceBands: computeBands(tree),
  };
}

const FINGERPRINT_FIELDS: readonly (keyof GoldFingerprint)[] = [
  'section',
  'parts',
  'noteLeaks',
  'maxDepth',
  'partShape',
  'confidenceBands',
];

/** Field-by-field diff of two fingerprints; `[]` when identical. Values are
 *  JSON-stringified for a stable, printable comparison of the nested shapes. */
export function diffFingerprint(
  expected: GoldFingerprint,
  actual: GoldFingerprint
): FingerprintDelta[] {
  const deltas: FingerprintDelta[] = [];
  for (const field of FINGERPRINT_FIELDS) {
    const e = JSON.stringify(expected[field]);
    const a = JSON.stringify(actual[field]);
    if (e !== a) deltas.push({ field, expected: e, actual: a });
  }
  return deltas;
}
