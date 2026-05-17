import type { CsiTree, CsiNode } from '../ast/types.js';

export interface SectionInference {
  readonly method: 'metadata' | 'content-high' | 'content-medium' | 'none';
  readonly confidence: 'high' | 'medium' | 'none';
  readonly inferredSection: string;
  readonly inferredTitle: string;
  readonly standardTitle?: string;
  readonly titleMatchScore?: number;
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
}

const KEYWORD_RE = /SECTION\s+(\d{2})\s+(\d{2})\s+(\d{2})/i;
const INLINE_TITLE_RE = /SECTION\s+\d{2}\s+\d{2}\s+\d{2}\s+(.*)/i;
const BARE_NUM_RE = /^(\d{2})\s+(\d{2})\s+(\d{2})$/;
const MAX_NODES = 50;

function flattenNodes(parts: readonly CsiNode[]): readonly CsiNode[] {
  const out: CsiNode[] = [];
  function walk(nodes: readonly CsiNode[]): void {
    for (const n of nodes) {
      if (out.length >= MAX_NODES) return;
      out.push(n);
      walk(n.children);
    }
  }
  walk(parts);
  return out;
}

function isValidTitle(text: string): boolean {
  const t = text.trim();
  return (
    t.length >= 3 &&
    t.length <= 150 &&
    !/^\d+$/.test(t) &&
    !KEYWORD_RE.test(t) &&
    !BARE_NUM_RE.test(t)
  );
}

function findInlineTitle(nodeText: string): string | null {
  const inlineMatch = INLINE_TITLE_RE.exec(nodeText);
  if (inlineMatch?.[1] !== undefined && isValidTitle(inlineMatch[1])) {
    return inlineMatch[1].trim();
  }
  return null;
}

function findFollowingTitle(nodes: readonly CsiNode[], fromIdx: number): string {
  const searchEnd = Math.min(fromIdx + 10, nodes.length);
  for (let i = fromIdx; i < searchEnd; i++) {
    const t = nodes[i]?.text?.trim() ?? '';
    if (isValidTitle(t)) return t;
  }
  return 'unknown';
}

function findTitle(nodes: readonly CsiNode[], sectionIdx: number): string {
  const inline = findInlineTitle(nodes[sectionIdx]?.text ?? '');
  return inline ?? findFollowingTitle(nodes, sectionIdx + 1);
}

export function computeTitleMatch(
  inferredTitle: string,
  standardTitle: string | null | undefined
): { titleMatch: SectionInference['titleMatch']; titleMatchScore: number | undefined } {
  if (standardTitle == null) return { titleMatch: 'unknown', titleMatchScore: undefined };
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .split(/\s+/)
        .filter(Boolean)
    );
  if (inferredTitle.toLowerCase().trim() === standardTitle.toLowerCase().trim()) {
    return { titleMatch: 'exact', titleMatchScore: 1 };
  }
  const wa = words(inferredTitle);
  const wb = words(standardTitle);
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  const score = union === 0 ? 1 : Math.round((intersection / union) * 100) / 100;
  return {
    titleMatch: score >= 0.7 ? 'close' : 'divergent',
    titleMatchScore: score,
  };
}

const NONE_RESULT: SectionInference = {
  method: 'none',
  confidence: 'none',
  inferredSection: 'unknown',
  inferredTitle: 'unknown',
  titleMatch: 'unknown',
};

function scanKeyword(nodes: readonly CsiNode[]): SectionInference | null {
  for (let i = 0; i < nodes.length; i++) {
    const m = KEYWORD_RE.exec(nodes[i]?.text ?? '');
    if (m !== null) {
      return {
        method: 'content-high',
        confidence: 'high',
        inferredSection: `${m[1]} ${m[2]} ${m[3]}`,
        inferredTitle: findTitle(nodes, i),
        titleMatch: 'unknown',
      };
    }
  }
  return null;
}

function scanBareNumber(nodes: readonly CsiNode[]): SectionInference | null {
  for (let i = 0; i < nodes.length; i++) {
    const m = BARE_NUM_RE.exec((nodes[i]?.text ?? '').trim());
    if (m !== null) {
      return {
        method: 'content-medium',
        confidence: 'medium',
        inferredSection: `${m[1]} ${m[2]} ${m[3]}`,
        inferredTitle: findTitle(nodes, i),
        titleMatch: 'unknown',
      };
    }
  }
  return null;
}

export function inferSectionMeta(tree: CsiTree): SectionInference {
  try {
    if (tree.section !== 'unknown' && tree.section.trim().length > 0) {
      return {
        method: 'metadata',
        confidence: 'high',
        inferredSection: tree.section,
        inferredTitle: tree.title,
        titleMatch: 'unknown',
      };
    }
    const nodes = flattenNodes(tree.parts);
    return scanKeyword(nodes) ?? scanBareNumber(nodes) ?? NONE_RESULT;
  } catch {
    return NONE_RESULT;
  }
}
