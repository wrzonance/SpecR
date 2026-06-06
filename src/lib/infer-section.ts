import type { SpecTree, SpecNode } from '../ast/types.js';
import { normalizeSectionNumber, sectionNumberFragment } from './section-number.js';

export interface SectionInference {
  readonly method: 'metadata' | 'content-high' | 'content-medium' | 'none';
  readonly confidence: 'high' | 'medium' | 'none';
  readonly inferredSection: string;
  readonly inferredTitle: string;
  readonly standardTitle?: string;
  readonly titleMatchScore?: number;
  readonly titleMatch: 'exact' | 'close' | 'divergent' | 'unknown';
}

const KEYWORD_RE = new RegExp(String.raw`\bSECTION\s+${sectionNumberFragment()}`, 'i');
const INLINE_TITLE_RE = new RegExp(
  String.raw`\bSECTION\s+${sectionNumberFragment()}(?:\s*[-–—]\s*|\s+)(\S.*)`,
  'i'
);
const BARE_NUM_RE = new RegExp(`^${sectionNumberFragment()}$`);
const MAX_NODES = 50;
const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 150;

function flattenNodes(parts: readonly SpecNode[]): readonly SpecNode[] {
  const out: SpecNode[] = [];
  function walk(nodes: readonly SpecNode[]): void {
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
    t.length >= TITLE_MIN_LENGTH &&
    t.length <= TITLE_MAX_LENGTH &&
    !/^\d+$/.test(t) &&
    !KEYWORD_RE.test(t) &&
    !BARE_NUM_RE.test(t)
  );
}

function findInlineTitle(nodeText: string): string | null {
  const inlineMatch = INLINE_TITLE_RE.exec(nodeText);
  if (inlineMatch?.[2] !== undefined && isValidTitle(inlineMatch[2])) {
    return inlineMatch[2].trim();
  }
  return null;
}

function findFollowingTitle(nodes: readonly SpecNode[], fromIdx: number): string {
  const searchEnd = Math.min(fromIdx + 10, nodes.length);
  for (let i = fromIdx; i < searchEnd; i++) {
    const t = nodes[i]?.text?.trim() ?? '';
    if (isValidTitle(t)) return t;
  }
  return 'unknown';
}

function findTitle(nodes: readonly SpecNode[], sectionIdx: number): string {
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

function scanKeyword(nodes: readonly SpecNode[]): SectionInference | null {
  for (let i = 0; i < nodes.length; i++) {
    const m = KEYWORD_RE.exec(nodes[i]?.text ?? '');
    const section = m === null ? null : normalizeSectionNumber(m[1] ?? '');
    if (section !== null) {
      return {
        method: 'content-high',
        confidence: 'high',
        inferredSection: section,
        inferredTitle: findTitle(nodes, i),
        titleMatch: 'unknown',
      };
    }
  }
  return null;
}

function scanBareNumber(nodes: readonly SpecNode[]): SectionInference | null {
  for (let i = 0; i < nodes.length; i++) {
    const m = BARE_NUM_RE.exec((nodes[i]?.text ?? '').trim());
    const section = m === null ? null : normalizeSectionNumber(m[1] ?? '');
    if (section !== null) {
      return {
        method: 'content-medium',
        confidence: 'medium',
        inferredSection: section,
        inferredTitle: findTitle(nodes, i),
        titleMatch: 'unknown',
      };
    }
  }
  return null;
}

export function inferSectionMeta(tree: SpecTree): SectionInference {
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
