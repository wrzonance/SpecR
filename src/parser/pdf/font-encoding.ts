import * as chardet from 'chardet';
import * as iconv from 'iconv-lite';
import type { ParseWarning } from '../../ast/types.js';
import { warningSuggestionFor } from '../text/index.js';
import type { PdfPageText, PdfTextItem } from './normalize.js';

export interface PdfFontEncodingRecovery {
  readonly pages: readonly PdfPageText[];
  readonly warnings: readonly ParseWarning[];
}

interface RemapDecision {
  readonly kind: 'remap';
  readonly encoding: string;
  readonly fingerprint: string;
  readonly text: string;
}

interface PassDecision {
  readonly kind: 'pass';
}

interface UnrecoverableDecision {
  readonly kind: 'unrecoverable';
}

type RecoveryDecision = RemapDecision | PassDecision | UnrecoverableDecision;

const MIN_GARBLED_CHARS = 16;
const MIN_REMAP_IMPROVEMENT = 2;
const GARBLED_SCORE_THRESHOLD = 4;
const SOURCE_ENCODINGS = ['windows-1252', 'ISO-8859-1', 'latin1'] as const;
const MOJIBAKE_RE = /[\u00c2\u00c3\u00e2][\u0080-\uffff]{1,2}|\ufffd/gu;

function warning(type: ParseWarning['type'], lineHint: string): ParseWarning {
  return { type, lineHint, suggestion: warningSuggestionFor(type) };
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function suspiciousSymbolCount(text: string): number {
  return [...text].filter((char) => /[$&=+_*<>|{}~`^\\]/u.test(char)).length;
}

function controlCount(text: string): number {
  return [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 32 && !/\s/u.test(char)) || (code >= 0x80 && code <= 0x9f);
  }).length;
}

function letterRatio(text: string): number {
  if (text.length === 0) return 0;
  const letters = [...text].filter((char) => /[A-Za-z]/u.test(char)).length;
  return letters / text.length;
}

function symbolRatio(text: string): number {
  if (text.length === 0) return 0;
  return suspiciousSymbolCount(text) / text.length;
}

function garbageScore(text: string): number {
  const mojibake = countMatches(text, MOJIBAKE_RE);
  const controls = controlCount(text);
  const lowLetters = letterRatio(text) < 0.12 ? 4 : 0;
  return mojibake * 3 + controls * 4 + Math.round(symbolRatio(text) * 12) + lowLetters;
}

function decodeCandidate(text: string, sourceEncoding: string): string | null {
  if (!iconv.encodingExists(sourceEncoding)) return null;
  const bytes = iconv.encode(text, sourceEncoding);
  return iconv.decode(bytes, 'utf-8');
}

function fingerprint(text: string, sourceEncoding: string): string {
  const bytes = iconv.encode(text, sourceEncoding);
  return chardet.detect(bytes) ?? 'unknown';
}

function remapCandidate(text: string, sourceEncoding: string): RemapDecision | null {
  const decoded = decodeCandidate(text, sourceEncoding);
  if (decoded === null || decoded === text) return null;
  return {
    kind: 'remap',
    encoding: sourceEncoding,
    fingerprint: fingerprint(text, sourceEncoding),
    text: decoded,
  };
}

function bestRemap(text: string, originalScore: number): RemapDecision | null {
  const candidates = SOURCE_ENCODINGS.flatMap((encoding) => {
    const candidate = remapCandidate(text, encoding);
    return candidate === null ? [] : [candidate];
  });
  const sorted = candidates.toSorted((a, b) => garbageScore(a.text) - garbageScore(b.text));
  const best = sorted[0];
  if (best === undefined) return null;
  return originalScore - garbageScore(best.text) >= MIN_REMAP_IMPROVEMENT ? best : null;
}

function decideRecovery(text: string): RecoveryDecision {
  const trimmed = text.trim();
  if (trimmed.length < MIN_GARBLED_CHARS) return { kind: 'pass' };
  const originalScore = garbageScore(trimmed);
  if (originalScore < GARBLED_SCORE_THRESHOLD) return { kind: 'pass' };
  const remapped = bestRemap(text, originalScore);
  return remapped ?? { kind: 'unrecoverable' };
}

function remapItem(item: PdfTextItem, sourceEncoding: string): PdfTextItem {
  return { ...item, str: decodeCandidate(item.str, sourceEncoding) ?? item.str };
}

function remapPage(page: PdfPageText, decision: RemapDecision): PdfPageText {
  return {
    ...page,
    text: decision.text,
    items: page.items.map((item) => remapItem(item, decision.encoding)),
  };
}

function recoveryLineHint(pageNumbers: readonly number[], decision: RemapDecision | null): string {
  const pages = `pages ${pageNumbers.join(', ')}`;
  if (decision === null) return `${pages}: detected symbol-heavy text with no stable remap`;
  return `${pages}: ${decision.encoding} bytes decoded as UTF-8 (${decision.fingerprint})`;
}

export function recoverPdfFontEncoding(pages: readonly PdfPageText[]): PdfFontEncodingRecovery {
  const remapped: number[] = [];
  const unrecoverable: number[] = [];
  let remapDecision: RemapDecision | null = null;
  const recoveredPages = pages.map((page) => {
    const decision = decideRecovery(page.text);
    if (decision.kind === 'pass') return page;
    if (decision.kind === 'unrecoverable') {
      unrecoverable.push(page.pageNumber);
      return page;
    }
    remapped.push(page.pageNumber);
    remapDecision = decision;
    return remapPage(page, decision);
  });
  const warnings: ParseWarning[] = [];
  if (remapped.length > 0) {
    warnings.push(warning('pdf-font-encoding-remapped', recoveryLineHint(remapped, remapDecision)));
  }
  if (unrecoverable.length > 0) {
    warnings.push(
      warning('pdf-font-encoding-unrecoverable', recoveryLineHint(unrecoverable, null))
    );
  }
  return { pages: recoveredPages, warnings };
}
