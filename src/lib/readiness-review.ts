import type { SpecNode, SpecTree } from '../ast/index.js';
import { summarizeHighlightReview, type HighlightReviewReport } from './highlight-review.js';

export type ReadinessFindingKind =
  'unresolved_choice_token' | 'specifier_note_present' | 'open_comment' | 'body_object_present';

// One resolvable blocker an editor must clear before a spec can leave the
// firm as Final (ADR-079). Every variant carries `nodeId`/`text` so a caller
// can point a specifier at the exact paragraph, plus kind-specific detail.
interface ReadinessFindingBase {
  readonly nodeId: string;
  readonly text: string;
}

export interface UnresolvedChoiceTokenFinding extends ReadinessFindingBase {
  readonly type: 'unresolved_choice_token';
  readonly kind: 'angle' | 'bracket';
  readonly options: readonly string[];
}

export interface SpecifierNotePresentFinding extends ReadinessFindingBase {
  readonly type: 'specifier_note_present';
}

export interface OpenCommentFinding extends ReadinessFindingBase {
  readonly type: 'open_comment';
  readonly author: string;
}

export interface BodyObjectPresentFinding extends ReadinessFindingBase {
  readonly type: 'body_object_present';
  // Text boxes only, never tables — a body table is structural content
  // (ADR-072), a text box is a sticky-note annotation (ADR-079 decision 4).
  readonly objectKind: 'textBox';
}

export type ReadinessFinding =
  | UnresolvedChoiceTokenFinding
  | SpecifierNotePresentFinding
  | OpenCommentFinding
  | BodyObjectPresentFinding;

export interface ReadinessSummary {
  readonly unresolvedChoiceToken: number;
  readonly specifierNotePresent: number;
  readonly openComment: number;
  readonly bodyObjectPresent: number;
  /** Always equals findings.length — the highlight advisory never counts here. */
  readonly total: number;
}

export interface SpecReadinessResult {
  readonly findings: readonly ReadinessFinding[];
  /** Advisory-only (ADR-079 decision 3): never consulted by the gate. */
  readonly highlightAdvisory: HighlightReviewReport;
}

function choiceTokenFindings(node: SpecNode): readonly ReadinessFinding[] {
  const tokens = node.meta.sourceFacts?.choiceTokens ?? [];
  return tokens.map((token) => ({
    type: 'unresolved_choice_token',
    nodeId: node.id,
    text: node.text,
    kind: token.kind,
    options: token.options,
  }));
}

function openCommentFindings(node: SpecNode): readonly ReadinessFinding[] {
  const comments = node.meta.sourceFacts?.comments ?? [];
  return comments
    .filter((comment) => !comment.closed)
    .map((comment) => ({
      type: 'open_comment',
      nodeId: node.id,
      text: node.text,
      author: comment.author,
    }));
}

function bodyObjectFinding(node: SpecNode): readonly ReadinessFinding[] {
  if (node.type === 'object' && node.meta.object?.kind === 'textBox') {
    return [
      { type: 'body_object_present', nodeId: node.id, text: node.text, objectKind: 'textBox' },
    ];
  }
  return [];
}

// A `note` always flags, checked before `meta.vanish` is ever consulted —
// mirrors the generator's own rendering order (generator/index.ts emits
// `note` unconditionally, then gates every other type on `vanish`). Every
// other node type short-circuits to no findings once vanished: nothing
// renders it in any output format, so a hidden choice token, comment, or
// text box cannot block an issuance the reader will never see (ADR-079
// decision 5, vanish-asymmetry-by-type).
function assessNode(node: SpecNode): readonly ReadinessFinding[] {
  if (node.type === 'note') {
    return [{ type: 'specifier_note_present', nodeId: node.id, text: node.text }];
  }
  if (node.meta.vanish === true) return [];
  return [...choiceTokenFindings(node), ...openCommentFindings(node), ...bodyObjectFinding(node)];
}

// A vanished non-note node hides its whole subtree in every renderer
// (generator/index.ts's collectParagraphs skips recursing once emitNode
// returns false; markdown.ts's renderNonStructural short-circuits the caller
// before it ever calls renderChildren; sec/index.ts's isHidden filter drops
// "its whole subtree"). A descendant that is not itself vanished still never
// reaches a reader once an ancestor is, so walkReadiness must not descend
// into it either — otherwise a hidden article's still-open comment or
// unresolved choice token would block an issuance no format ever renders.
function isSuppressedSubtree(node: SpecNode): boolean {
  return node.type !== 'note' && node.meta.vanish === true;
}

function walkReadiness(nodes: readonly SpecNode[]): readonly ReadinessFinding[] {
  return nodes.flatMap((node) => {
    const findings = assessNode(node);
    if (isSuppressedSubtree(node)) return findings;
    return [...findings, ...walkReadiness(node.children)];
  });
}

/**
 * Walks a `SpecTree` once, producing both the gate's block list and the
 * dry-run report's findings from the same pass (ADR-079 decision 2) — a
 * report that says "clean" and a gate that still blocks would be a worse bug
 * than either behavior alone. `highlightAdvisory` delegates to ADR-074's
 * existing detector unchanged and is never reimplemented here.
 */
export function evaluateSpecReadiness(tree: SpecTree): SpecReadinessResult {
  return {
    findings: walkReadiness(tree.parts),
    highlightAdvisory: summarizeHighlightReview(tree),
  };
}

export function summarizeReadinessFindings(
  findings: readonly ReadinessFinding[]
): ReadinessSummary {
  const countOf = (type: ReadinessFinding['type']): number =>
    findings.filter((finding) => finding.type === type).length;
  return {
    unresolvedChoiceToken: countOf('unresolved_choice_token'),
    specifierNotePresent: countOf('specifier_note_present'),
    openComment: countOf('open_comment'),
    bodyObjectPresent: countOf('body_object_present'),
    total: findings.length,
  };
}
