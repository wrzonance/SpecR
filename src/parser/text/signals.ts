import type { NodeType } from '../../ast/types.js';
import { stripPartPrefix } from '../part-prefix.js';

export type LineType = NodeType | 'blank' | 'header';

export interface LineClassification {
  readonly type: LineType;
  readonly text: string;
  readonly level: number;
}

const SECTION_HEADER_RE = /^SECTION\s+\d{2}\s+\d{2}\s+\d{2}/i;
const PART_RE = /^PART\s+\d+/i;
const ARTICLE_RE = /^\d+\.\d+(?:\s+|(?=\S))/;
const NOISE_PREFIX_RE = /^(?:\]\]?|\[_+\])\s*/;

function stripNoisePrefixes(s: string): string {
  return s.replace(NOISE_PREFIX_RE, '');
}

interface PrSignal {
  readonly re: RegExp;
  readonly type: NodeType;
  readonly level: number;
}

const PR_SIGNALS: readonly PrSignal[] = [
  { re: /^[A-Z]\.(?:\s+|\b)/, type: 'pr1', level: 2 },
  { re: /^\d+\.(?:\s+|(?=[^\d\s]))/, type: 'pr2', level: 3 },
  { re: /^[a-z]\.\s+\S/, type: 'pr3', level: 4 },
  { re: /^\d+\)\s+\S/, type: 'pr4', level: 5 },
  { re: /^[a-z]\)\s+\S/, type: 'pr5', level: 6 },
];

function stripArticlePrefix(s: string): string {
  return s.replace(/^\d+\.\d+\s*/, '').trim();
}

function stripPrPrefix(s: string): string {
  return s.replace(/^(?:[A-Za-z][.)]|\d+[.)])\s*/, '').trim();
}

function indentLevel(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === '\t') count += 4;
    else if (ch === ' ') count += 1;
    else break;
  }
  return Math.min(6, Math.floor(count / 4));
}

function matchPrSignal(trimmed: string): LineClassification | null {
  for (const sig of PR_SIGNALS) {
    if (sig.re.test(trimmed)) {
      return { type: sig.type, text: stripPrPrefix(trimmed), level: sig.level };
    }
  }
  return null;
}

export function classifyLine(line: string): LineClassification {
  if (line.trim() === '') {
    return { type: 'blank', text: '', level: -1 };
  }

  const trimmed = stripNoisePrefixes(line.trim());

  if (SECTION_HEADER_RE.test(trimmed)) {
    return { type: 'header', text: trimmed, level: -1 };
  }
  if (PART_RE.test(trimmed)) {
    return { type: 'part', text: stripPartPrefix(trimmed), level: 0 };
  }
  if (ARTICLE_RE.test(trimmed)) {
    return { type: 'article', text: stripArticlePrefix(trimmed), level: 1 };
  }

  const pr = matchPrSignal(trimmed);
  if (pr !== null) {
    return pr;
  }

  const indent = indentLevel(line);
  return {
    type: 'continuation',
    text: trimmed,
    level: indent > 0 ? indent : -1,
  };
}
