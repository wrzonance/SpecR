// src/lib/hierarchy-report.ts
import type {
  NodeType,
  SignalConflict,
  SignalNumber,
  SpecNode,
  SpecNodeInference,
  SpecTree,
} from '../ast/index.js';
import { consumesNumber, getLabel, nodeTypeToNormalizedIlvl } from '../ast/index.js';
import { HIERARCHY_REVIEW_THRESHOLD } from './hierarchy-summary.js';

/** Longest a `ScoredParagraph.preview` may be before truncation. No ellipsis is
 *  appended — it's a straight prefix so it still substring-matches the full
 *  rendered text (see the label-non-drift test). */
export const PREVIEW_MAX = 80;

export interface ScoredParagraph {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly ilvl: number;
  readonly label: string;
  readonly preview: string;
  readonly confidence: number;
  readonly signalUsed: SignalNumber;
  readonly agreed: readonly SignalNumber[];
  readonly evidence: readonly string[];
  readonly conflicts?: readonly SignalConflict[];
}

export interface HierarchyReport {
  readonly counts: {
    readonly scored: number;
    readonly unscored: number;
    readonly belowThreshold: number;
  };
  /** Present when unscored > 0 — why, never folded into another bucket (ADR-055). */
  readonly unscoredReason?: string;
  /** ALL scored paragraphs, worst-first (ascending confidence). */
  readonly paragraphs: readonly ScoredParagraph[];
}

// Non-structural node types are never scored — the same skip-set hierarchy-
// summary.ts uses (its NON_STRUCTURAL). Re-declared locally per the module-
// boundary rule: that module's exports are not widened just to share this set.
const NON_STRUCTURAL = new Set<NodeType>(['spec', 'note', 'continuation']);

// Same two reason strings as hierarchy-summary.ts (ADR-055) — re-declared
// locally, see the NON_STRUCTURAL comment above for why they aren't imported.
const EXPLICIT_STRUCTURE_REASON = 'explicit structure from source markup — no inference to score';
const PRE_PROVENANCE_REASON =
  'no inference provenance recorded — the 5-signal engine did not score these paragraphs ' +
  '(pre-provenance parse, non-DOCX source, or manually inserted); re-importing a DOCX master ' +
  'regenerates scores';

interface Acc {
  scored: number;
  unscored: number;
  belowThreshold: number;
  readonly paragraphs: ScoredParagraph[];
}

// Where a node sits in the CSI render chain — mirrors renderMarkdown's
// root→part→article→pr-tier descent (src/generator/markdown.ts). Which getLabel()
// call applies is determined by POSITION, not by the node's own type — exactly
// how renderPart/renderArticle/renderPrNode treat any non-skipped child as the
// next level down regardless of its actual type.
type LabelCtx =
  | { readonly kind: 'part'; readonly index: number }
  | { readonly kind: 'article'; readonly index: number; readonly partNumber: number }
  | { readonly kind: 'pr'; readonly index: number; readonly depth: number };

function computeLabel(ctx: LabelCtx, nodeType: NodeType): string {
  if (ctx.kind === 'part') return getLabel('part', ctx.index);
  if (ctx.kind === 'article') return getLabel('article', ctx.index, ctx.partNumber);
  return getLabel(nodeType, ctx.index);
}

// The context a node's own children inherit, keyed off the position we just
// resolved THIS node at (not its type) — matches renderPart/renderArticle/
// renderPrNode each recursing into a fixed next level.
function childContext(ctx: LabelCtx): (index: number) => LabelCtx {
  if (ctx.kind === 'part') {
    const partNumber = ctx.index + 1;
    return (index) => ({ kind: 'article', index, partNumber });
  }
  if (ctx.kind === 'article') {
    return (index) => ({ kind: 'pr', index, depth: 0 });
  }
  const depth = ctx.depth + 1;
  return (index) => ({ kind: 'pr', index, depth });
}

function previewText(text: string): string {
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text;
}

function toScoredParagraph(
  node: SpecNode,
  label: string,
  inference: SpecNodeInference
): ScoredParagraph {
  const conflicts = node.meta.conflicts;
  return {
    nodeId: node.id,
    nodeType: node.type,
    ilvl: nodeTypeToNormalizedIlvl(node.type),
    label,
    preview: previewText(node.text),
    confidence: inference.confidence,
    signalUsed: inference.signalUsed,
    agreed: inference.agreed,
    evidence: inference.evidence,
    ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
  };
}

// Tallies one structural node the same way hierarchy-summary.ts's tally() does —
// but unlike that function, which keeps only the below-threshold subset, this
// records EVERY scored node so the report can surface the full worst-first list.
function tallyNode(node: SpecNode, label: string, acc: Acc, threshold: number): void {
  const inference = node.meta.inference;
  if (!inference) {
    acc.unscored += 1;
    return;
  }
  acc.scored += 1;
  if (inference.confidence < threshold) acc.belowThreshold += 1;
  acc.paragraphs.push(toScoredParagraph(node, label, inference));
}

function walkSiblings(
  nodes: readonly SpecNode[],
  ctxAt: (index: number) => LabelCtx,
  acc: Acc,
  threshold: number
): void {
  let ordinal = 0;
  for (const node of nodes) {
    visitNode(node, ctxAt(ordinal), acc, threshold);
    // Advance the CSI ordinal only past consumesNumber siblings, so an
    // interleaved note/continuation/vanish node never shifts a real sibling's
    // label — the same rule renderChildren() uses.
    if (consumesNumber(node)) ordinal += 1;
  }
}

// One recursive step: mirrors renderMarkdown's renderRoot/renderPart/
// renderArticle/renderPrNode chain for label/ordinal purposes, but tallies with
// hierarchy-summary.ts's wider recursion (into NON_STRUCTURAL children too) so
// the two can never drift on counts.
function visitNode(node: SpecNode, ctx: LabelCtx, acc: Acc, threshold: number): void {
  // A soft-removed (vanish) node hides its entire subtree — matches
  // hierarchy-summary.ts's prune and the markdown renderer's vanish short-circuit.
  if (node.meta.vanish) return;
  if (NON_STRUCTURAL.has(node.type)) {
    walkSiblings(node.children, () => ctx, acc, threshold);
    return;
  }
  tallyNode(node, computeLabel(ctx, node.type), acc, threshold);
  walkSiblings(node.children, childContext(ctx), acc, threshold);
}

function walkScored(tree: SpecTree, threshold: number): Acc {
  const acc: Acc = { scored: 0, unscored: 0, belowThreshold: 0, paragraphs: [] };
  walkSiblings(tree.parts, (index) => ({ kind: 'part', index }), acc, threshold);
  return acc;
}

/**
 * Per-paragraph hierarchy-inference scoring report (WS2, #424): every scored
 * structural paragraph in `tree`, worst confidence first, labeled exactly as a
 * client would see in the rendered markdown (src/generator/markdown.ts). Pure
 * function over the AST — no I/O; the REST endpoint / MCP tool / demo view built
 * on top of this (later tasks) own persistence and transport.
 *
 * `counts` and `unscoredReason` intentionally mirror summarizeHierarchy()
 * (hierarchy-summary.ts) exactly — see the counts-equivalence test, which is
 * what guarantees the two independent implementations agree. `paragraphs`
 * differs from that module's `lowConfidence`: it carries ALL scored nodes, not
 * just the below-threshold subset, worst-first.
 */
export function buildHierarchyReport(
  tree: SpecTree,
  source: string | null,
  threshold: number = HIERARCHY_REVIEW_THRESHOLD
): HierarchyReport {
  const acc = walkScored(tree, threshold);
  const paragraphs = [...acc.paragraphs].sort(
    (a, b) => a.confidence - b.confidence || a.nodeId.localeCompare(b.nodeId)
  );
  return {
    counts: { scored: acc.scored, unscored: acc.unscored, belowThreshold: acc.belowThreshold },
    ...(acc.unscored > 0
      ? { unscoredReason: source === 'ufgs' ? EXPLICIT_STRUCTURE_REASON : PRE_PROVENANCE_REASON }
      : {}),
    paragraphs,
  };
}
