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

// Canonical normalized ilvl: part=0, article=1, pr1=2, pr2=3, pr3=4, pr4=5, pr5=6
const NODE_TYPE_TO_NORMALIZED: Partial<Record<NodeType, number>> = {
  part: 0,
  article: 1,
  pr1: 2,
  pr2: 3,
  pr3: 4,
  pr4: 5,
  pr5: 6,
};

const NODE_TYPES_BY_ILVL: readonly NodeType[] = [
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
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
    .slice(1)
    .filter((h) => h.nodeType !== winner.nodeType)
    .map((h) => ({
      signal: h.signal,
      reportedIlvl: h.normalizedIlvl,
      reportedNodeType: h.nodeType,
    }));
}

// Specifier notes are editorial metadata, not spec content: banner text in any
// vendor variant, or a note-named paragraph style (ARCATnote). Footnote/endnote
// styles are document apparatus, not specifier notes.
function isNoteParagraph(para: DocxParagraph, styleMap: StyleMap): boolean {
  if (isSpecifierNote(para.text)) return true;
  if (!para.styleId) return false;
  const style = styleMap.styles.get(para.styleId);
  const label = `${para.styleId} ${style?.name ?? ''}`;
  return /note/i.test(label) && !/foot|end/i.test(label);
}

function continuationResult(
  para: DocxParagraph,
  prevNonContIlvl: number,
  isVanish: boolean
): ClassifiedParagraph {
  return {
    paragraph: para,
    resolvedIlvl: prevNonContIlvl,
    nodeType: 'continuation',
    signalUsed: 3,
    conflicts: [],
    isVanish,
  };
}

function classifyOne(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  prevNonContIlvl: number
): ClassifiedParagraph {
  // specifier notes render as vanish notes — SEC NTE/NPR parity
  if (isNoteParagraph(para, styleMap)) {
    return continuationResult(para, prevNonContIlvl, true);
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

  const winner = hits[0];
  if (!winner) {
    return continuationResult(para, prevNonContIlvl, para.isVanish);
  }
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

function makeContinuationNode(cp: ClassifiedParagraph, source: Source): SpecNode {
  return {
    id: uuidv4(),
    type: cp.isVanish ? 'note' : 'continuation',
    text: cp.paragraph.text,
    children: [],
    meta: { source, ...(cp.isVanish ? { vanish: true } : {}) },
  };
}

function makeNode(cp: ClassifiedParagraph, children: SpecNode[], source: Source): SpecNode {
  return {
    id: uuidv4(),
    type: cp.isVanish ? 'note' : cp.nodeType,
    text: cp.paragraph.text,
    children,
    meta: {
      source,
      ...(cp.isVanish ? { vanish: true as const } : {}),
    },
  };
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
  const partCount = roots.filter((n) => n.type === 'part').length;
  const junkRoots = roots.filter((n) => n.type !== 'part');

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

  for (const cp of classified) {
    if (cp.nodeType === 'continuation') {
      lastNonContChildren.push(makeContinuationNode(cp, source));
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
