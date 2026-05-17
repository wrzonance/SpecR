import { v4 as uuidv4 } from 'uuid';
import { inferSectionMeta } from '../../lib/infer-section.js';
import type { CsiNode, CsiNodeMeta, CsiTree, NodeType, SecRef } from '../../ast/types.js';
import { classifyLine } from './signals.js';
import type { LineType } from './signals.js';

type StructuralType = Exclude<LineType, 'blank' | 'header' | 'continuation'>;

const SECTION_EXTRACT_RE = /SECTION\s+(\d{2})\s+(\d{2})\s+(\d{2})(?:\s*[-–—]\s*(.+))?/i;
const BARE_SECTION_RE = /^(\d{2})\s+(\d{2})\s+(\d{2})(?:\s*[-–—]\s*(.+))?/;

/** Scan up to this many non-blank lines for the SECTION header.
 * 10 instead of 5: UFGS files have a metadata header block before the SECTION line
 */
const MAX_HEADER_SCAN = 10;

interface StackEntry {
  readonly children: CsiNode[];
  readonly level: number;
}

function makeMeta(): CsiNodeMeta {
  return { source: 'unknown' };
}

function makeNode(type: NodeType, text: string, children: CsiNode[]): CsiNode {
  return { id: uuidv4(), type, text, children, meta: makeMeta() };
}

function extractSectionMeta(
  lines: readonly string[]
): { readonly section: string; readonly title: string } | null {
  let scanned = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const trimmed = line.trim();
    const m = SECTION_EXTRACT_RE.exec(trimmed) ?? BARE_SECTION_RE.exec(trimmed);
    if (m !== null) {
      return {
        section: `${m[1]} ${m[2]} ${m[3]}`,
        title: (m[4] ?? '').trim() || 'unknown',
      };
    }
    if (++scanned >= MAX_HEADER_SCAN) break;
  }
  return null;
}

function isStructural(type: LineType): type is StructuralType {
  return type !== 'blank' && type !== 'header' && type !== 'continuation';
}

export interface ParsedText {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
  readonly capabilities: readonly string[];
}

function pushContinuation(stack: StackEntry[], text: string): void {
  if (stack.length > 1) {
    stack[stack.length - 1]!.children.push(makeNode('continuation', text, []));
  }
}

function buildTree(lines: readonly string[]): readonly CsiNode[] {
  const rootChildren: CsiNode[] = [];
  const rootEntry: StackEntry = { children: rootChildren, level: -1 };
  const stack: StackEntry[] = [rootEntry];

  for (const line of lines) {
    const cls = classifyLine(line);

    if (cls.type === 'blank' || cls.type === 'header') continue;

    if (cls.type === 'continuation') {
      pushContinuation(stack, cls.text);
      continue;
    }

    if (!isStructural(cls.type)) continue;

    while (stack.length > 1 && stack[stack.length - 1]!.level >= cls.level) {
      stack.pop();
    }

    const children: CsiNode[] = [];
    const node = makeNode(cls.type, cls.text, children);
    stack[stack.length - 1]!.children.push(node);
    stack.push({ children: children, level: cls.level });
  }

  return rootChildren;
}

function applyInference(rawTree: CsiTree): CsiTree {
  const inference = inferSectionMeta(rawTree);
  const shouldApply = inference.method !== 'metadata' && inference.confidence !== 'none';
  if (!shouldApply) return rawTree;
  return {
    ...rawTree,
    section: inference.inferredSection,
    title: inference.inferredTitle,
  };
}

export function parseText(text: string): ParsedText {
  const lines = text.split(/\r?\n/);
  const headerMeta = extractSectionMeta(lines);
  const parts = buildTree(lines);

  const rawTree: CsiTree = {
    id: uuidv4(),
    section: headerMeta?.section ?? 'unknown',
    title: headerMeta?.title ?? 'unknown',
    parts,
  };

  const tree = applyInference(rawTree);

  return { tree, refs: [], capabilities: ['read-only'] };
}
