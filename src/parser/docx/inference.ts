import { v4 as uuidv4 } from 'uuid';
import { ilvlToNodeType } from './rules.js';
import {
  matchTextSignal,
  matchIndentSignal,
  isPartHeading,
  isSpecifierNote,
} from './heuristics.js';
import type {
  ClassifiedParagraph,
  DocxParagraph,
  NumberingMap,
  SignalConflict,
  StyleMap,
} from './types.js';
import type { SpecNode, SpecTree, NodeType, ParseWarning } from '../../ast/types.js';
import { planPartStrip, rebaseSourceFacts } from '../part-prefix.js';

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

function trySignal2(
  para: DocxParagraph,
  styleMap: StyleMap,
  numberingMap: NumberingMap
): SignalHit | null {
  if (!para.styleId) return null;
  const styleInfo = styleMap.styles.get(para.styleId);
  if (styleInfo?.suppressesNumbering) return null;
  const resolved = styleMap.resolvedNumPr.get(para.styleId);
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

// A visible PART heading stores only its name in the AST; the "PART n -" label is
// render-derived (getLabel). Strip it, rebasing any source-fact offsets onto the
// shorter text so comment/color/choice anchors stay valid. Non-parts and a bare
// "PART n" (strip would empty it) keep their raw text + facts unchanged.
function nodeContent(cp: ClassifiedParagraph): {
  readonly text: string;
  readonly sourceFacts?: NonNullable<DocxParagraph['sourceFacts']>;
} {
  const facts = cp.paragraph.sourceFacts;
  const plan = cp.nodeType === 'part' ? planPartStrip(cp.paragraph.text) : null;
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
function makeNode(cp: ClassifiedParagraph, children: SpecNode[], source: Source): SpecNode {
  const content = nodeContent(cp);
  return {
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
}

function appendContinuation(cp: ClassifiedParagraph, target: SpecNode[], source: Source): void {
  target.push(makeContinuationNode(cp, source));
}

function drainTop(stack: StackEntry[], roots: SpecNode[], source: Source): void {
  const popped = stack.pop();
  if (!popped) return;
  const node = makeNode(popped.cp, popped.children, source);
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

export function buildTree(
  classified: readonly ClassifiedParagraph[],
  section: string,
  title: string,
  source: Source
): SpecTree {
  const roots: SpecNode[] = [];
  const stack: StackEntry[] = [];
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
      drainTop(stack, roots, source);
    }

    const entry: StackEntry = { cp, children: [] };
    stack.push(entry);
    lastNonContChildren = entry.children;
  }

  while (stack.length > 0) {
    drainTop(stack, roots, source);
  }

  return { id: uuidv4(), section, title, parts: roots };
}
