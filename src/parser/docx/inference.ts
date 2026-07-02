import { v4 as uuidv4 } from 'uuid';
import { ilvlToNodeType } from './rules.js';
import {
  matchTextSignal,
  matchIndentSignal,
  isPartHeading,
  isSpecifierNote,
  isDecorationSeparator,
} from './heuristics.js';
import type {
  ClassifiedParagraph,
  DocxParagraph,
  NumberingMap,
  SignalConflict,
  StyleMap,
  StyleNumPr,
} from './types.js';
import type { SpecNode, SpecTree, NodeType, ParseWarning } from '../../ast/types.js';
import { getLabel, consumesNumber } from '../../ast/index.js';
import {
  planPartStrip,
  planOutlineNumberStrip,
  planLabelStrip,
  rebaseSourceFacts,
} from '../part-prefix.js';

// Canonical normalized ilvl: part=0, article=1, pr1=2, ..., pr7=8
const NODE_TYPE_TO_NORMALIZED: Partial<Record<NodeType, number>> = {
  part: 0,
  article: 1,
  pr1: 2,
  pr2: 3,
  pr3: 4,
  pr4: 5,
  pr5: 6,
  pr6: 7,
  pr7: 8,
};

const NODE_TYPES_BY_ILVL: readonly NodeType[] = [
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
];

function toNormalizedIlvl(nodeType: NodeType): number {
  return NODE_TYPE_TO_NORMALIZED[nodeType] ?? 0;
}

interface SignalHit {
  readonly nodeType: NodeType;
  readonly normalizedIlvl: number;
  readonly signal: 1 | 2 | 3 | 4 | 5;
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
  //       levels) — ARCAT generates the "PART n" prefix from lvlText, so the
  //       paragraph text is just "GENERAL"/"PRODUCTS"/"EXECUTION".
  // Generic <ol> lists satisfy neither, so the false positive stays dead.
  if (
    nodeType === 'part' &&
    !isPartHeading(para.text) &&
    !numberingMap.specShapedNumIds.has(para.numId)
  ) {
    return null;
  }
  return { nodeType, normalizedIlvl: toNormalizedIlvl(nodeType), signal: 1 };
}

// CPI lead-in styles PR1lc..PR7lc ("lead-in copy") carry no numbering of their own
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
  return { nodeType, normalizedIlvl: toNormalizedIlvl(nodeType), signal: 2 };
}

function trySignal4(para: DocxParagraph): SignalHit | null {
  const match = matchTextSignal(para.text);
  if (!match) return null;
  return { nodeType: match.nodeType, normalizedIlvl: match.normalizedIlvl, signal: 4 };
}

function trySignal5(para: DocxParagraph): SignalHit | null {
  const estimated = matchIndentSignal(para.leftIndent);
  if (estimated === null) return null;
  const nodeType = NODE_TYPES_BY_ILVL[estimated];
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

// An article is the top content tier under a PART, so it cannot be deeply indented.
// Hand-authored manufacturer docs reuse numIds with inconsistent ilvl baselines, so
// a nested list item can resolve to 'article' via the global articleIlvl offset
// (parsing-needs-fixing.docx: "1. Normal street clothes…", numId 13 ilvl 3 → article,
// yet indented at pr-tier). When the winning numbering/style signal says 'article'
// but indentation places the paragraph ≥2 tiers deeper, the numbering baseline is
// misaligned — defer to indentation so the item nests instead of becoming a spurious
// top-level 3.x. A genuine article sits at indent tier ≤2 (clean CPI articles reach
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

// Specifier notes are editorial metadata, not spec content: banner text in any
// vendor variant, or a note-named paragraph style (ARCATnote). Footnote/endnote
// styles are document apparatus, not specifier notes.
function isNoteParagraph(para: DocxParagraph, styleMap: StyleMap): boolean {
  if (isSpecifierNote(para.text)) return true;
  if (!para.styleId) return false;
  const style = styleMap.styles.get(para.styleId);
  const label = `${para.styleId} ${style?.name ?? ''}`;
  // exclusion targets Word's built-in FootnoteText/EndnoteText styles —
  // bare /foot|end/ would also exclude e.g. VendorNote ("vEND-or")
  return /note/i.test(label) && !/footnote|endnote/i.test(label);
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
    isVanish,
    isNote,
  };
}

function classifyOne(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  prevNonContIlvl: number
): ClassifiedParagraph {
  // Hidden + specifier-note paragraphs are non-structural. Both carry meta.vanish
  // (a specifier note is editorial content hidden in the published spec, matching
  // SEC <NTE> semantics), but isNote splits them: a genuine note becomes a 'note'
  // AST node ([NOTE]); hidden non-note body content becomes a suppressed
  // 'continuation' so renderers drop it instead of leaking it as a note (#296).
  const isNote = isNoteParagraph(para, styleMap);
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

  const hits: SignalHit[] = [];

  const s1 = trySignal1(para, numberingMap);
  if (s1) hits.push(s1);
  const s2 = trySignal2(para, styleMap, numberingMap);
  if (s2) hits.push(s2);
  const s4 = trySignal4(para);
  if (s4) hits.push(s4);
  const s5 = trySignal5(para);
  if (s5) hits.push(s5);

  const rawWinner = hits[0];
  if (!rawWinner) {
    return continuationResult(para, prevNonContIlvl, para.isVanish, false);
  }
  const winner = correctMisalignedArticle(rawWinner, hits);
  const conflicts = buildConflicts(winner, hits);

  return {
    paragraph: para,
    resolvedIlvl: winner.normalizedIlvl,
    nodeType: winner.nodeType,
    signalUsed: winner.signal,
    conflicts,
    isVanish: para.isVanish,
  };
}

export function classifyParagraphs(
  paragraphs: readonly DocxParagraph[],
  numberingMap: NumberingMap,
  styleMap: StyleMap
): ClassifiedParagraph[] {
  let prevNonContIlvl = 0;

  return paragraphs.map((para): ClassifiedParagraph => {
    const classified = classifyOne(para, numberingMap, styleMap, prevNonContIlvl);
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
function makeContinuationNode(cp: ClassifiedParagraph, source: Source): SpecNode {
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
// A Signal-4 (manual text-outline) article records its id in `s4ArticleIds` so the
// label-strip post-pass touches ONLY manual outlines — a Word/style-numbered article's
// visible text is real content, never a typed label (Codex adversarial review).
function makeNode(
  cp: ClassifiedParagraph,
  children: SpecNode[],
  source: Source,
  s4ArticleIds: Set<string>
): SpecNode {
  const content = nodeContent(cp);
  const node: SpecNode = {
    id: uuidv4(),
    type: cp.nodeType,
    text: content.text,
    children,
    meta: {
      source,
      ...(cp.conflicts.length > 0 ? { conflicts: cp.conflicts } : {}),
      ...(content.sourceFacts ? { sourceFacts: content.sourceFacts } : {}),
    },
  };
  if (cp.signalUsed === 4 && cp.nodeType === 'article') s4ArticleIds.add(node.id);
  return node;
}

function appendContinuation(cp: ClassifiedParagraph, target: SpecNode[], source: Source): void {
  target.push(makeContinuationNode(cp, source));
}

function drainTop(
  stack: StackEntry[],
  roots: SpecNode[],
  source: Source,
  s4ArticleIds: Set<string>
): void {
  const popped = stack.pop();
  if (!popped) return;
  const node = makeNode(popped.cp, popped.children, source, s4ArticleIds);
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
  const junkRoots = visible.filter((n) => n.type !== 'part');

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
  return warnings;
}

// Strip an article's author-typed outline number IFF it equals the article's own
// render-derived CSI label ("P.n"). This is the only reliable way to tell an outline
// LABEL ("1.2 RELATED SECTIONS", where 1.2 IS the article's position) from a decimal
// VALUE that merely opens the text ("2.1 GHz frequency band"): the value is stripped
// only in the impossible-to-avoid coincidence that it equals the article's position.
// Source-fact offsets are rebased onto the shorter text.
function stripArticleLabel(article: SpecNode, partNumber: number, ordinal: number): SpecNode {
  const plan = planLabelStrip(article.text, getLabel('article', ordinal, partNumber));
  if (!plan) return article;
  const facts = article.meta.sourceFacts;
  const meta = facts
    ? { ...article.meta, sourceFacts: rebaseSourceFacts(facts, plan.removed, plan.text.length) }
    : article.meta;
  return { ...article, text: plan.text, meta };
}

// Walk a part's children, advancing the CSI ordinal only past numbered siblings
// (consumesNumber) — exactly as the renderer does — so each article's computed label
// matches what getLabel would prepend at render time. Only Signal-4 (manual-outline)
// articles are eligible to strip; a numbered/style-derived article's text is content.
function stripLabelsUnderPart(
  part: SpecNode,
  partNumber: number,
  s4ArticleIds: ReadonlySet<string>
): SpecNode {
  let ordinal = 0;
  const children = part.children.map((child) => {
    const next =
      consumesNumber(child) && child.type === 'article' && s4ArticleIds.has(child.id)
        ? stripArticleLabel(child, partNumber, ordinal)
        : child;
    if (consumesNumber(child)) ordinal += 1;
    return next;
  });
  return { ...part, children };
}

// Post-pass over the assembled tree: single-dot article numbers are stripped here (not
// inline) because a node's position — and therefore its label — is only known once the
// whole tree exists. Multi-dot pr numbers are already stripped inline (unambiguous).
function stripArticleOutlineLabels(
  roots: readonly SpecNode[],
  s4ArticleIds: ReadonlySet<string>
): SpecNode[] {
  let partOrdinal = 0;
  return roots.map((root) => {
    const next =
      consumesNumber(root) && root.type === 'part'
        ? stripLabelsUnderPart(root, partOrdinal + 1, s4ArticleIds)
        : root;
    if (consumesNumber(root)) partOrdinal += 1;
    return next;
  });
}

export function buildTree(
  classified: readonly ClassifiedParagraph[],
  section: string,
  title: string,
  source: Source
): SpecTree {
  const roots: SpecNode[] = [];
  const stack: StackEntry[] = [];
  // Node ids of Signal-4 (manual text-outline) articles — the only articles whose
  // leading number may be an author-typed label the strip post-pass should remove.
  const s4ArticleIds = new Set<string>();
  let lastNonContChildren: SpecNode[] = roots;

  // Empty paragraphs are layout spacing, not content — drop before structuring.
  // A blank that inherited a numbered style (Signal 2) otherwise became an empty
  // numbered node (#122): a phantom row consuming a CSI number; an empty paragraph
  // at root previously rendered as a phantom PART.
  const content = classified.filter((cp) => cp.paragraph.text.trim().length > 0);

  for (const cp of content) {
    if (cp.nodeType === 'continuation') {
      appendContinuation(cp, lastNonContChildren, source);
      continue;
    }

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.cp.resolvedIlvl < cp.resolvedIlvl) break;
      drainTop(stack, roots, source, s4ArticleIds);
    }

    const entry: StackEntry = { cp, children: [] };
    stack.push(entry);
    lastNonContChildren = entry.children;
  }

  while (stack.length > 0) {
    drainTop(stack, roots, source, s4ArticleIds);
  }

  return { id: uuidv4(), section, title, parts: stripArticleOutlineLabels(roots, s4ArticleIds) };
}
