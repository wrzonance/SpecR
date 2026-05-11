import { v4 as uuidv4 } from 'uuid';
import { ilvlToNodeType } from './rules.js';
import { matchTextSignal, matchIndentSignal } from './heuristics.js';
import type {
  ClassifiedParagraph,
  DocxParagraph,
  NumberingMap,
  SignalConflict,
  StyleMap,
} from './types.js';
import type { CsiNode, CsiTree, NodeType } from '../../ast/types.js';

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

function classifyOne(
  para: DocxParagraph,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  prevNonContIlvl: number
): ClassifiedParagraph {
  const hits: SignalHit[] = [];

  const s1 = trySignal1(para, numberingMap);
  if (s1) hits.push(s1);
  const s2 = trySignal2(para, styleMap, numberingMap);
  if (s2) hits.push(s2);
  const s4 = trySignal4(para);
  if (s4) hits.push(s4);
  const s5 = trySignal5(para);
  if (s5) hits.push(s5);

  if (hits.length === 0) {
    return {
      paragraph: para,
      resolvedIlvl: prevNonContIlvl,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      isVanish: para.isVanish,
    };
  }

  const winner = hits[0];
  if (!winner)
    return {
      paragraph: para,
      resolvedIlvl: prevNonContIlvl,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      isVanish: para.isVanish,
    };
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
  readonly children: CsiNode[];
}

function makeNode(cp: ClassifiedParagraph, children: CsiNode[], source: Source): CsiNode {
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

function drainTop(stack: StackEntry[], roots: CsiNode[], source: Source): void {
  const popped = stack.pop();
  if (!popped) return;
  const node = makeNode(popped.cp, popped.children, source);
  const parentChildren = stack.length > 0 ? stack[stack.length - 1]!.children : roots;
  parentChildren.push(node);
}

export function buildTree(
  classified: readonly ClassifiedParagraph[],
  section: string,
  title: string,
  source: Source
): CsiTree {
  const roots: CsiNode[] = [];
  const stack: StackEntry[] = [];
  let lastNonContChildren: CsiNode[] = roots;

  for (const cp of classified) {
    if (cp.nodeType === 'continuation') {
      lastNonContChildren.push({
        id: uuidv4(),
        type: 'continuation',
        text: cp.paragraph.text,
        children: [],
        meta: { source },
      });
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1]!.cp.resolvedIlvl >= cp.resolvedIlvl) {
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
