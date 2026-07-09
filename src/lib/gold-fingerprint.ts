// src/lib/gold-fingerprint.ts
import type { NodeType, SecRef, SpecNode, SpecTree } from '../ast/index.js';
import { nodeTypeToNormalizedIlvl } from '../ast/index.js';
import { fixtureRecord, visibleParts } from './fixture-snapshot.js';
import { buildHierarchyReport } from './hierarchy-report.js';
import { HIERARCHY_REVIEW_THRESHOLD } from './hierarchy-summary.js';

/** Below this confidence a scored paragraph lands in the `low` band; `[LOW, THRESHOLD)`
 *  is `review`; `>= THRESHOLD` is `high`. Coarser than a raw score so benign jitter
 *  never forces a re-bless. */
export const LOW_CONFIDENCE_BAND = 0.3;

// The renderers' skip-set — no normalized ilvl, never counted (mirrors
// hierarchy-summary.ts / the markdown renderer).
const NON_STRUCTURAL = new Set<NodeType>(['spec', 'note', 'continuation']);

// Real-content exclusions: a note's own text is editorial ("junk today"); the
// `spec` root is a wrapper. Unlike NON_STRUCTURAL, `continuation` is NOT here —
// its wrapped body text is real content that can be silently truncated.
const NON_CONTENT = new Set<NodeType>(['spec', 'note']);

// Normalized character length: whitespace runs collapsed to one space and
// trimmed, so benign reflow/whitespace jitter never changes the count.
function normalizedLen(text: string): number {
  return text.trim().replace(/\s+/g, ' ').length;
}

// Sum normalized real-content character length over `node` (inclusive) and its
// descendants. Prunes vanish subtrees; skips a note's/spec-root's OWN text but
// still recurses children — a real paragraph mis-nested under a note is still
// real content.
function contentCharsOf(node: SpecNode): number {
  if (node.meta.vanish === true) return 0;
  let sum = NON_CONTENT.has(node.type) ? 0 : normalizedLen(node.text);
  for (const child of node.children) sum += contentCharsOf(child);
  return sum;
}

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
  readonly contentChars: readonly number[];
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

// Returns the highest normalized ilvl present; -1 is a deterministic sentinel meaning
// "no structural nodes" (e.g. a parts-less or all-vanish tree), not an error.
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

/**
 * Coarse structural + confidence-band fingerprint of a parsed spec (WS3, #426).
 * Pure — no I/O. Reuses `fixtureRecord` for the parts/note-leak facts and
 * `buildHierarchyReport` for the confidence bands so it can never drift from the
 * renderers or the WS2 scoring report.
 */
export function computeFingerprint(tree: SpecTree, refs: readonly SecRef[]): GoldFingerprint {
  const { parts, noteLeaks } = fixtureRecord(tree, refs);
  const visible = visibleParts(tree);
  return {
    section: tree.section,
    parts,
    noteLeaks,
    maxDepth: maxDepthOf(tree),
    partShape: visible.map(partShapeOf),
    confidenceBands: computeBands(tree),
    contentChars: visible.map(contentCharsOf),
  };
}

const FINGERPRINT_FIELDS = [
  'section',
  'parts',
  'noteLeaks',
  'maxDepth',
  'partShape',
  'confidenceBands',
  'contentChars',
] as const satisfies readonly (keyof GoldFingerprint)[];

// Exhaustiveness guard: if a new GoldFingerprint key is added without a matching entry
// above, `Exclude<...>` is no longer `never` and this line fails to type-check — so
// diffFingerprint can never silently stop checking a field.
type _MissingFingerprintField = Exclude<keyof GoldFingerprint, (typeof FINGERPRINT_FIELDS)[number]>;
export const _fingerprintFieldsExhaustive: _MissingFingerprintField extends never ? true : never =
  true;

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
