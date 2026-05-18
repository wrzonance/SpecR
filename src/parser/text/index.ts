import { v4 as uuidv4 } from 'uuid';
import { inferSectionMeta } from '../../lib/infer-section.js';
import type {
  SpecNode,
  SpecNodeMeta,
  SpecTree,
  NodeType,
  ParseWarning,
  ParseWarningType,
  SecRef,
} from '../../ast/types.js';
import { classifyLine } from './signals.js';
import type { LineType } from './signals.js';

type StructuralType = Exclude<LineType, 'blank' | 'header' | 'continuation'>;

interface DroppedLine {
  readonly line: number;
  readonly text: string;
}

interface BuildResult {
  readonly parts: readonly SpecNode[];
  readonly droppedAtRoot: readonly DroppedLine[];
  readonly partLineIndex: ReadonlyMap<string, number>;
}

const ROOT_CONTINUATION_CAP = 5;

const WARNING_SUGGESTIONS: Readonly<Record<ParseWarningType, string>> = {
  'no-structure-found':
    'No PART/Article/list-prefix lines detected. Check for non-standard numbering or PDF/encoding corruption.',
  'empty-part':
    'Part has no Articles. May indicate truncated content or unrecognized child prefixes.',
  'root-continuation':
    'Continuation text appeared before first structural heading and was dropped. Possible noise-prefix bleed; consider whether this line should be a heading.',
};

const SECTION_EXTRACT_RE = /SECTION\s+(\d{2})\s+(\d{2})\s+(\d{2})(?:\s*[-–—]\s*(.+))?/i;
const BARE_SECTION_RE = /^(\d{2})\s+(\d{2})\s+(\d{2})(?:\s*[-–—]\s*(.+))?/;

/** Scan up to this many non-blank lines for the SECTION header.
 * 10 instead of 5: UFGS files have a metadata header block before the SECTION line
 */
const MAX_HEADER_SCAN = 10;

interface StackEntry {
  readonly children: SpecNode[];
  readonly level: number;
}

function makeMeta(): SpecNodeMeta {
  return { source: 'unknown' };
}

function makeNode(type: NodeType, text: string, children: SpecNode[]): SpecNode {
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
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly capabilities: readonly string[];
}

function pushContinuation(
  stack: StackEntry[],
  text: string,
  lineIdx: number,
  droppedAtRoot: DroppedLine[]
): void {
  if (stack.length > 1) {
    stack[stack.length - 1]!.children.push(makeNode('continuation', text, []));
    return;
  }
  droppedAtRoot.push({ line: lineIdx + 1, text });
}

function attachStructuralNode(
  stack: StackEntry[],
  cls: { type: StructuralType; text: string; level: number }
): SpecNode {
  while (stack.length > 1 && stack[stack.length - 1]!.level >= cls.level) {
    stack.pop();
  }
  const children: SpecNode[] = [];
  const node = makeNode(cls.type, cls.text, children);
  stack[stack.length - 1]!.children.push(node);
  stack.push({ children: children, level: cls.level });
  return node;
}

function buildTree(lines: readonly string[]): BuildResult {
  const rootChildren: SpecNode[] = [];
  const rootEntry: StackEntry = { children: rootChildren, level: -1 };
  const stack: StackEntry[] = [rootEntry];
  const droppedAtRoot: DroppedLine[] = [];
  const partLineIndex = new Map<string, number>();

  lines.forEach((line, lineIdx) => {
    const cls = classifyLine(line);
    if (cls.type === 'blank' || cls.type === 'header') return;
    if (cls.type === 'continuation') {
      pushContinuation(stack, cls.text, lineIdx, droppedAtRoot);
      return;
    }
    if (!isStructural(cls.type)) return;
    const node = attachStructuralNode(stack, {
      type: cls.type,
      text: cls.text,
      level: cls.level,
    });
    if (node.type === 'part') partLineIndex.set(node.id, lineIdx + 1);
  });

  return { parts: rootChildren, droppedAtRoot, partLineIndex };
}

function makeWarning(type: ParseWarningType, lineHint?: string): ParseWarning {
  return {
    type,
    ...(lineHint !== undefined ? { lineHint } : {}),
    suggestion: WARNING_SUGGESTIONS[type],
  };
}

function detectEmptyPartWarnings(result: BuildResult): readonly ParseWarning[] {
  const warnings: ParseWarning[] = [];
  for (const part of result.parts) {
    if (part.type !== 'part') continue;
    if (part.children.length > 0) continue;
    const line = result.partLineIndex.get(part.id);
    const lineHint = line !== undefined ? `line ${line}: ${part.text}` : undefined;
    warnings.push(makeWarning('empty-part', lineHint));
  }
  return warnings;
}

function detectRootContinuationWarnings(result: BuildResult): readonly ParseWarning[] {
  return result.droppedAtRoot
    .slice(0, ROOT_CONTINUATION_CAP)
    .map((drop) => makeWarning('root-continuation', `line ${drop.line}: ${drop.text}`));
}

function detectWarnings(result: BuildResult): readonly ParseWarning[] {
  const warnings: ParseWarning[] = [];
  if (result.parts.length === 0) warnings.push(makeWarning('no-structure-found'));
  warnings.push(...detectEmptyPartWarnings(result));
  warnings.push(...detectRootContinuationWarnings(result));
  return warnings;
}

function applyInference(rawTree: SpecTree): SpecTree {
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
  const buildResult = buildTree(lines);
  const warnings = detectWarnings(buildResult);

  const rawTree: SpecTree = {
    id: uuidv4(),
    section: headerMeta?.section ?? 'unknown',
    title: headerMeta?.title ?? 'unknown',
    parts: buildResult.parts,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  const tree = applyInference(rawTree);
  const capabilities = warnings.length > 0 ? ['read-only', 'parse-warnings'] : ['read-only'];

  return { tree, refs: [], capabilities };
}
