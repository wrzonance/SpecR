import { v4 as uuidv4 } from 'uuid';
import { ilvlToNodeType } from './rules.js';
import { scoreHierarchyConfidence } from './hierarchy-confidence.js';
import {
  matchTextSignal,
  matchIndentSignal,
  isPartHeading,
  isDecorationSeparator,
} from './heuristics.js';
import { computeNoteRoles, isNoteParagraph } from './note-roles.js';
import type { NoteRole } from '../../lib/note-delimiters.js';
import type {
  ClassifiedParagraph,
  DocxParagraph,
  NumberingMap,
  SignalConflict,
  SignalId,
  StyleMap,
  StyleNumPr,
} from './types.js';
import type { SpecNode, SpecTree, NodeType, ParseWarning } from '../../ast/types.js';
import { nodeTypeToNormalizedIlvl, NODE_TYPES_BY_NORMALIZED_ILVL } from '../../ast/index.js';
import {
  planPartStrip,
  planOutlineNumberStrip,
  rebaseSourceFacts,
  auditPartNumbering,
} from '../part-prefix.js';
import { stripOutlineLabels } from './outline-label-strip.js';
import { pageBreakMeta, resolvePageBreakBefore } from './page-break.js';

interface SignalHit {
  readonly nodeType: NodeType;
  readonly normalizedIlvl: number;
  readonly signal: SignalId;
}

function trySignal1(para: DocxParagraph, numberingMap: NumberingMap): SignalHit | null {
  if (para.numId === undefined || para.numId === 0) return null;
  if (para.ilvl === undefined) return null;
  const nodeType = ilvlToNodeType(para.ilvl, numberingMap.articleIlvl);
  if (nodeType === 'continuation') return null;
  // Guard: ilvl=0 maps to 'part', but LibreOffice and Word also assign numId+ilvl=0
  // to generic <ol> list items. Claim 'part' only when either:
  //   (a) the literal text matches the PART heading pattern, or
  //   (b) the numbering definition itself is spec-shaped (>=3 pStyle-linked
  //       levels) — the numbering generates the "PART n" prefix from lvlText, so
  //       the paragraph text is just "GENERAL"/"PRODUCTS"/"EXECUTION".
  // Generic <ol> lists satisfy neither, so the false positive stays dead.
  if (
    nodeType === 'part' &&
    !isPartHeading(para.text) &&
    !numberingMap.specShapedNumIds.has(para.numId)
  ) {
    return null;
  }
  return { nodeType, normalizedIlvl: nodeTypeToNormalizedIlvl(nodeType), signal: 1 };
}

// Lead-in styles PR1lc..PR7lc ("lead-in copy") carry no numbering of their own
// but occupy the tier of their base PRn style. Their `next` points at PRn and their
// text is a list lead-in ("Section Includes:") that introduces a numbered PR2 list.
const LEAD_IN_STYLE = /^(PR\d+)lc$/i;

// Resolve a lead-in style to its base PRn tier so the lead-in becomes a structural
// node and its list items nest under it (instead of orphaning at the article tier).
// Only fires when the base style actually has resolved numbering — otherwise there is
// no tier to inherit and the paragraph stays a continuation. An explicit numId=0
// opt-out (suppressesNumbering) is honored by the caller BEFORE this runs.
function resolveLeadInNumPr(styleId: string, styleMap: StyleMap): StyleNumPr | undefined {
  const base = LEAD_IN_STYLE.exec(styleId)?.[1];
  return base ? styleMap.resolvedNumPr.get(base) : undefined;
}

function trySignal2(
  para: DocxParagraph,
  styleMap: StyleMap,
  numberingMap: NumberingMap
): SignalHit | null {
  // Explicit numId=0 is OOXML's "remove numbering" sentinel: the paragraph opted out
  // of its style's list membership (e.g. a de-numbered, centered "****** [OR] ******"
  // separator that keeps the PART style SPECText1 but sets <w:numId w:val="0"/>). Signal
  // 1 already bails on numId=0; Signal 2 must too, or the STYLE's numbering resurrects a
  // paragraph the author explicitly un-numbered into a spurious structural node
  // (more-broken-parsing.docx 08 14 16 → 5 parts). Text/indent signals still run below.
  if (para.numId === 0) return null;
  if (!para.styleId) return null;
  const styleInfo = styleMap.styles.get(para.styleId);
  if (styleInfo?.suppressesNumbering) return null;
  const resolved =
    styleMap.resolvedNumPr.get(para.styleId) ?? resolveLeadInNumPr(para.styleId, styleMap);
  if (!resolved) return null;
  const nodeType = ilvlToNodeType(resolved.ilvl, numberingMap.articleIlvl);
  if (nodeType === 'continuation') return null;
  return { nodeType, normalizedIlvl: nodeTypeToNormalizedIlvl(nodeType), signal: 2 };
}

function trySignal4(para: DocxParagraph): SignalHit | null {
  const match = matchTextSignal(para.text);
  if (!match) return null;
  return { nodeType: match.nodeType, normalizedIlvl: match.normalizedIlvl, signal: 4 };
}

// w:jc alignments whose leftIndent is horizontal positioning, not outline depth:
// centered and right-aligned (end === right in LTR) paragraphs. A centered title carries
// a large symmetric indent purely to center it; reading a level from that indent
// promoted the section header to a spurious deep-pr root. Left/start/both/distribute are
// normal flow where indentation genuinely signals nesting, so Signal 5 still runs.
const NON_OUTLINE_JC = new Set(['center', 'right', 'end']);

function trySignal5(para: DocxParagraph): SignalHit | null {
  if (para.jc !== undefined && NON_OUTLINE_JC.has(para.jc)) return null;
  const estimated = matchIndentSignal(para.leftIndent);
  if (estimated === null) return null;
  const nodeType = NODE_TYPES_BY_NORMALIZED_ILVL[estimated];
  if (!nodeType) return null;
  return { nodeType, normalizedIlvl: estimated, signal: 5 };
}

function buildConflicts(winner: SignalHit, hits: readonly SignalHit[]): readonly SignalConflict[] {
  return hits
    .filter((h) => h !== winner && h.nodeType !== winner.nodeType)
    .map((h) => ({
      signal: h.signal,
      reportedIlvl: h.normalizedIlvl,
      reportedNodeType: h.nodeType,
    }));
}

function buildAgreed(winner: SignalHit, hits: readonly SignalHit[]): readonly SignalId[] {
  return hits
    .filter(
      (h) =>
        h !== winner && h.nodeType === winner.nodeType && h.normalizedIlvl === winner.normalizedIlvl
    )
    .map((h) => h.signal);
}

// An article is the top content tier under a PART, so it cannot be deeply indented.
// Hand-authored docs reuse numIds with inconsistent ilvl baselines, so
// a nested list item can resolve to 'article' via the global articleIlvl offset
// (parsing-needs-fixing.docx: "1. Normal street clothes…", numId 13 ilvl 3 → article,
// yet indented at pr-tier). When the winning numbering/style signal says 'article'
// but indentation places the paragraph ≥2 tiers deeper, the numbering baseline is
// misaligned — defer to indentation so the item nests instead of becoming a spurious
// top-level 3.x. A genuine article sits at indent tier ≤2 (clean articles reach
// ~900 twips → tier 2), so the ≥3 threshold never demotes a real article. The losing
// Signal-1 'article' is preserved as a conflict (never dropped) by buildConflicts.
const ARTICLE_INDENT_CONTRADICTION_MIN_TIER = 3;

function correctMisalignedArticle(winner: SignalHit, hits: readonly SignalHit[]): SignalHit {
  if (winner.nodeType !== 'article' || (winner.signal !== 1 && winner.signal !== 2)) {
    return winner;
  }
  // Corroboration: a literal "N.N" text prefix (Signal 4) or a second numbering/style
  // signal independently calling this an article outweighs indentation — only an
  // article with no other non-indent support is a misaligned-numbering artifact.
  const articleVotes = hits.filter((h) => h.signal !== 5 && h.nodeType === 'article');
  if (articleVotes.length > 1) {
    return winner;
  }
  const indentHit = hits.find((h) => h.signal === 5);
  if (!indentHit || indentHit.normalizedIlvl < ARTICLE_INDENT_CONTRADICTION_MIN_TIER) {
    return winner;
  }
  // Demote, honoring signal precedence: hits are in priority order (1,2,4,5), so the
  // first remaining non-article hit prefers a literal "N." text tier over the raw
  // twips estimate. Falls back to the indent hit when it's the only non-article hit.
  return hits.find((h) => h.nodeType !== 'article') ?? indentHit;
}

function continuationResult(
  para: DocxParagraph,
  prevNonContIlvl: number,
  isVanish: boolean,
  isNote: boolean
): ClassifiedParagraph {
  return {
    paragraph: para,
    resolvedIlvl: prevNonContIlvl,
    nodeType: 'continuation',
    signalUsed: 3,
    conflicts: [],
    agreed: [],
    isVanish,
    isNote,
  };
}

// The 5-signal cascade (Signals 1/2/4/5 — Signal 3 is the continuation fallback
// classifyOne applies when this returns no hits). Extracted out of classifyOne so
// the role/vanish/note/decoration guard clauses above it stay under the ESLint
// complexity/cognitive-complexity budget (10) — same inputs/outputs as the inline
// cascade it replaces, no new branching.
function collectSignalHits(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap
): SignalHit[] {
  const hits: SignalHit[] = [];
  const s1 = trySignal1(para, numberingMap);
  if (s1) hits.push(s1);
  const s2 = trySignal2(para, styleMap, numberingMap);
  if (s2) hits.push(s2);
  const s4 = trySignal4(para);
  if (s4) hits.push(s4);
  const s5 = trySignal5(para);
  if (s5) hits.push(s5);
  return hits;
}

function classifyOne(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  prevNonContIlvl: number,
  role: NoteRole
): ClassifiedParagraph {
  // A rule-row delimiter (an asterisk-only line marking an asterisk-rule-delimited
  // note region's boundary, #292) is never structural content: it produces NO
  // SpecNode at all — buildTree drops any paragraph with suppressed: true before
  // tree assembly. Checked first, ahead of the vanish/note/decoration guards below,
  // since a rule row can otherwise be vanish- or decoration-shaped and must not fall
  // through to those branches instead.
  if (role === 'rule') {
    return { ...continuationResult(para, prevNonContIlvl, para.isVanish, false), suppressed: true };
  }

  // Hidden + specifier-note paragraphs are non-structural. Both carry meta.vanish
  // (a specifier note is editorial content hidden in the published spec, matching
  // SEC <NTE> semantics), but isNote splits them: a genuine note becomes a 'note'
  // AST node ([NOTE]); hidden non-note body content becomes a suppressed
  // 'continuation' so renderers drop it instead of leaking it as a note (#296).
  // role === 'note' extends this: a paragraph enclosed by a paired rule-row region
  // (#292) is a note even when isNoteParagraph's banner/style checks miss it.
  const isNote = role === 'note' || isNoteParagraph(para, styleMap);
  if (para.isVanish || isNote) {
    return continuationResult(para, prevNonContIlvl, true, isNote);
  }

  // Editorial separators ("****** [OR] ******", asterisk/dash rules) are never
  // structural — route them to a plain (visible) continuation before any signal.
  // Defense-in-depth for the de-numbered-PART-separator class (08 14 16 / 08 11 13):
  // the numId=0 Signal-2 guard already handles the common case, but a separator that
  // kept both a PART style and live numbering would otherwise become a spurious PART.
  if (isDecorationSeparator(para.text)) {
    return continuationResult(para, prevNonContIlvl, para.isVanish, false);
  }

  const hits = collectSignalHits(para, numberingMap, styleMap);

  const rawWinner = hits[0];
  if (!rawWinner) {
    return continuationResult(para, prevNonContIlvl, para.isVanish, false);
  }
  const winner = correctMisalignedArticle(rawWinner, hits);
  const conflicts = buildConflicts(winner, hits);
  const agreed = buildAgreed(winner, hits);

  return {
    paragraph: para,
    resolvedIlvl: winner.normalizedIlvl,
    nodeType: winner.nodeType,
    signalUsed: winner.signal,
    conflicts,
    agreed,
    isVanish: para.isVanish,
  };
}

// The note-region drift signal (#292): a paragraph "carries its own structural
// numbering" — the proof that an open asterisk wall has drifted out of phase and is
// swallowing real content — when EITHER Signal 1 (a live positive numId) OR Signal 2
// (its style resolves to a real tier via trySignal2) fires. Signal 2 is what a
// text-pattern heading gate cannot see: a style-numbered PART/article/list item with
// no literal "PART n" text and no direct numId (Codex PR #461). Reuses trySignal2 so
// the numId=0 / suppressesNumbering / lead-in opt-out logic is never duplicated.
function hasStructuralNumbering(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap
): boolean {
  if (para.numId !== undefined && para.numId > 0) return true;
  return trySignal2(para, styleMap, numberingMap) !== null;
}

export function classifyParagraphs(
  paragraphs: readonly DocxParagraph[],
  numberingMap: NumberingMap,
  styleMap: StyleMap
): ClassifiedParagraph[] {
  let prevNonContIlvl = 0;
  const roles = computeNoteRoles(paragraphs, (para) =>
    hasStructuralNumbering(para, numberingMap, styleMap)
  );

  return paragraphs.map((para, i): ClassifiedParagraph => {
    const role = roles[i] ?? 'none';
    const classified = classifyOne(para, numberingMap, styleMap, prevNonContIlvl, role);
    if (classified.nodeType !== 'continuation') {
      prevNonContIlvl = classified.resolvedIlvl;
    }
    return classified;
  });
}

type Source = 'arcat' | 'cpi' | 'unknown';

interface StackEntry {
  readonly cp: ClassifiedParagraph;
  readonly children: SpecNode[];
  // Resolved at push time (buildTree's forwarding/redirect logic), since drainTop
  // may build this entry's SpecNode much later — the raw cp.paragraph.pageBreakBefore
  // is not authoritative on its own (see isPageBreakOwnedByPrecedingObject below).
  readonly pageBreakBefore: boolean;
}

function sourceFactsMeta(cp: ClassifiedParagraph): {
  readonly sourceFacts?: NonNullable<DocxParagraph['sourceFacts']>;
} {
  return cp.paragraph.sourceFacts ? { sourceFacts: cp.paragraph.sourceFacts } : {};
}

// Non-structural paragraphs (classifyParagraphs routes every vanish/note here as
// a 'continuation'). A genuine specifier note becomes a 'note' (rendered as
// [NOTE]); hidden non-note content becomes a suppressed 'continuation' carrying
// meta.vanish, which every renderer drops (#296). Text is kept verbatim — hidden
// content is retained as-authored for document-control tracking.
function makeContinuationNode(
  cp: ClassifiedParagraph,
  source: Source,
  pageBreakBefore: boolean
): SpecNode {
  return {
    id: uuidv4(),
    type: cp.isNote ? 'note' : 'continuation',
    text: cp.paragraph.text,
    children: [],
    // Carry conflicts here too (mirrors makeNode): a profile can demote a
    // paragraph to 'continuation' while the un-profiled base inference disagreed,
    // and that losing signal must still be persisted via meta.conflicts rather
    // than dropped at serialization ("conflicts persisted, never dropped"). (#317)
    meta: {
      source,
      ...(cp.conflicts.length > 0 ? { conflicts: cp.conflicts } : {}),
      ...(cp.isVanish ? { vanish: true } : {}),
      ...sourceFactsMeta(cp),
      ...pageBreakMeta(pageBreakBefore),
    },
  };
}

// A heading stores only its name in the AST; the CSI label ("PART n -", "1.2", "A.")
// is render-derived (getLabel). Strip the label the author baked into the text so it
// does not double at render, rebasing source-fact offsets onto the shorter text.
//   • part → "PART n -" / "N.0" prefix (planPartStrip)
//   • article/pr classified by the decimal text signal (Signal 4) → the typed
//     "1.4.2" outline number (planOutlineNumberStrip). Gated on Signal 4 so a
//     styled/numbered node's text — which is real content, never an outline prefix —
//     is never touched (styled docs carry zero Signal-4 nodes).
// A strip that would empty the text (a bare "PART n" / bare number) is skipped.
function planNodeStrip(cp: ClassifiedParagraph): { text: string; removed: number } | null {
  if (cp.nodeType === 'part') return planPartStrip(cp.paragraph.text);
  if (cp.signalUsed === 4) return planOutlineNumberStrip(cp.paragraph.text);
  return null;
}

function nodeContent(cp: ClassifiedParagraph): {
  readonly text: string;
  readonly sourceFacts?: NonNullable<DocxParagraph['sourceFacts']>;
} {
  const facts = cp.paragraph.sourceFacts;
  const plan = planNodeStrip(cp);
  if (!plan) {
    return facts ? { text: cp.paragraph.text, sourceFacts: facts } : { text: cp.paragraph.text };
  }
  return facts
    ? { text: plan.text, sourceFacts: rebaseSourceFacts(facts, plan.removed, plan.text.length) }
    : { text: plan.text };
}

// Structural nodes only. classifyParagraphs routes every vanish/note paragraph to
// a 'continuation' (handled by makeContinuationNode), so a cp reaching makeNode is
// always visible, non-note, structural content — its type maps straight through.
// A Signal-4 (manual text-outline) article OR pr node records its id in `s4NodeIds` so
// the label-strip post-pass touches ONLY manual outlines — a Word/style-numbered node's
// visible text is real content, never a typed label (Codex adversarial review). Parts are
// excluded: their "PART n -" prefix is stripped inline (planPartStrip), not by label match.
function makeNode(
  cp: ClassifiedParagraph,
  children: SpecNode[],
  source: Source,
  s4NodeIds: Set<string>,
  pageBreakBefore: boolean
): SpecNode {
  const content = nodeContent(cp);
  const inference = scoreHierarchyConfidence(
    { signalUsed: cp.signalUsed, agreed: cp.agreed },
    cp.conflicts,
    cp.nodeType
  );
  const node: SpecNode = {
    id: uuidv4(),
    type: cp.nodeType,
    text: content.text,
    children,
    meta: {
      source,
      ...(cp.conflicts.length > 0 ? { conflicts: cp.conflicts } : {}),
      ...(content.sourceFacts ? { sourceFacts: content.sourceFacts } : {}),
      ...(inference ? { inference } : {}),
      ...pageBreakMeta(pageBreakBefore),
    },
  };
  if (cp.signalUsed === 4 && cp.nodeType !== 'part') s4NodeIds.add(node.id);
  return node;
}

function drainTop(
  stack: StackEntry[],
  roots: SpecNode[],
  source: Source,
  s4NodeIds: Set<string>
): void {
  const popped = stack.pop();
  if (!popped) return;
  const node = makeNode(popped.cp, popped.children, source, s4NodeIds, popped.pageBreakBefore);
  const top = stack[stack.length - 1];
  const parentChildren = top !== undefined ? top.children : roots;
  parentChildren.push(node);
}

// MasterFormat specs typically have 3 parts; more is permitted but uncommon
// (warn above 3), and counts past 5 usually mean headings were over-matched.
const TYPICAL_PART_COUNT = 3;
const PLAUSIBLE_MAX_PARTS = 5;

function partCountWarning(partCount: number): ParseWarning | null {
  if (partCount <= TYPICAL_PART_COUNT) return null;
  const suggestion =
    partCount > PLAUSIBLE_MAX_PARTS
      ? `${partCount} PART nodes detected — more than ${PLAUSIBLE_MAX_PARTS} usually means headings were over-matched`
      : `${partCount} PART nodes detected — MasterFormat allows this, but specs typically have ${TYPICAL_PART_COUNT}`;
  return { type: 'unusual-part-count', suggestion };
}

// Sanity post-pass: a healthy CSI parse has a small number of part-type roots
// (typically 3) and nothing else at root. Degraded parses previously rendered
// silently — 21 11 00agf.docx produced 34 roots with zero warnings.
export function auditTreeStructure(roots: readonly SpecNode[]): ParseWarning[] {
  const warnings: ParseWarning[] = [];
  const visible = roots.filter((n) => n.meta.vanish !== true);
  const partCount = visible.filter((n) => n.type === 'part').length;
  // A captured body object (#300, ADR-072) at root — e.g. a table before the
  // document's first PART heading — is real, modeled content, never preamble
  // or unclassified junk; excluded here the same way 'part' itself is.
  const junkRoots = visible.filter((n) => n.type !== 'part' && n.type !== 'object');

  if (partCount === 0) {
    warnings.push({
      type: 'no-structure-found',
      suggestion:
        'no PART headings detected — document may not be a CSI spec, or its numbering convention is unrecognized',
    });
  }
  if (junkRoots.length > 0) {
    const first = junkRoots[0];
    warnings.push({
      type: 'root-continuation',
      ...(first && first.text ? { lineHint: first.text.slice(0, 60) } : {}),
      suggestion: `${junkRoots.length} node(s) at root level are not PART headings (preamble or unclassified content)`,
    });
  }
  const countWarning = partCountWarning(partCount);
  if (countWarning) warnings.push(countWarning);
  warnings.push(...auditPartNumbering(visible));
  return warnings;
}

// Empty paragraphs are layout spacing, not content — excluded from stack/continuation
// processing. A blank that inherited a numbered style (Signal 2) otherwise became an
// empty numbered node (#122): a phantom row consuming a CSI number; an empty paragraph
// at root previously rendered as a phantom PART. A suppressed rule-row delimiter (#292)
// is excluded the same way — it produces no SpecNode at all. This does NOT exclude the
// paragraph from body-object attachment (#300) below: a captured table/text-box's
// precedingParagraphIndex may point at exactly such an empty spacer (2 of 3 real table
// hosts in the proof fixture are empty spacer paragraphs) — the object must still
// attach after whatever structural node preceded it.
function isStructuralContent(cp: ClassifiedParagraph): boolean {
  return cp.paragraph.text.trim().length > 0 && cp.suppressed !== true;
}

// Appends a continuation to the current attachment point, or pops shallower stack
// frames and pushes a new frame — becoming the new attachment point for whatever
// follows, continuations and body objects (#300) alike. Returns the attachment point
// unchanged for a continuation (it never becomes one itself), or the newly pushed
// frame's own children array when `cp` is structural. `pageBreakBefore` is the
// EFFECTIVE flag buildTree already resolved for this cp (#497) — never read from
// cp.paragraph directly here, since forwarding/redirect may have moved it.
function processStructuralParagraph(
  cp: ClassifiedParagraph,
  stack: StackEntry[],
  roots: SpecNode[],
  lastNonContChildren: SpecNode[],
  source: Source,
  s4NodeIds: Set<string>,
  pageBreakBefore: boolean
): SpecNode[] {
  if (cp.nodeType === 'continuation') {
    lastNonContChildren.push(makeContinuationNode(cp, source, pageBreakBefore));
    return lastNonContChildren;
  }
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined || top.cp.resolvedIlvl < cp.resolvedIlvl) break;
    drainTop(stack, roots, source, s4NodeIds);
  }
  const entry: StackEntry = { cp, children: [], pageBreakBefore };
  stack.push(entry);
  return entry.children;
}

export function buildTree(
  classified: readonly ClassifiedParagraph[],
  section: string,
  title: string,
  source: Source,
  // Body objects (#300, ADR-072) a sibling capture pass (index.ts) found and
  // converted to SpecNodes: a table/text-box before the document's first
  // paragraph, and everything else keyed on the paragraph index it follows in
  // the ORIGINAL `classified` array. Both default to "none" so every existing
  // caller is unaffected.
  objectsBeforeFirst: readonly SpecNode[] = [],
  objectsByPrecedingIndex: ReadonlyMap<number, readonly SpecNode[]> = new Map()
): SpecTree {
  const roots: SpecNode[] = [...objectsBeforeFirst];
  const stack: StackEntry[] = [];
  // Node ids of Signal-4 (manual text-outline) article/pr nodes — the only nodes whose
  // leading number/letter may be an author-typed label the strip post-pass should remove.
  const s4NodeIds = new Set<string>();
  let lastNonContChildren: SpecNode[] = roots;
  // Carries a page break (#497) forward across a paragraph isStructuralContent
  // filters out (empty/blank spacer, or a suppressed rule-row delimiter, #292) until
  // it reaches the next paragraph that actually becomes a SpecNode. Reset to false
  // the moment a structural paragraph consumes it.
  let pendingPageBreak = false;

  // Iterate EVERY classified paragraph, unfiltered by index (#300): a body object's
  // attachment key is the paragraph's position in this ORIGINAL array, so a
  // filtered-out (empty/suppressed) paragraph at that index must still receive its
  // attached object(s) — only the structural stack/continuation handling skips it.
  classified.forEach((cp, i) => {
    const pageBreakBefore = resolvePageBreakBefore(
      cp,
      i,
      pendingPageBreak,
      objectsByPrecedingIndex
    );
    if (isStructuralContent(cp)) {
      pendingPageBreak = false;
      lastNonContChildren = processStructuralParagraph(
        cp,
        stack,
        roots,
        lastNonContChildren,
        source,
        s4NodeIds,
        pageBreakBefore
      );
    } else {
      pendingPageBreak = pageBreakBefore;
    }
    lastNonContChildren.push(...(objectsByPrecedingIndex.get(i) ?? []));
  });

  while (stack.length > 0) drainTop(stack, roots, source, s4NodeIds);

  return { id: uuidv4(), section, title, parts: stripOutlineLabels(roots, s4NodeIds, 1) };
}
