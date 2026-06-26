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
const ITEM_Y_TOLERANCE = 3;
const ITEM_GROUP_GAP = 120;
const SOURCE_ENCODINGS = ['windows-1252', 'ISO-8859-1', 'latin1'] as const;
const REPLACEMENT_CHAR = '\uFFFD';
const MOJIBAKE_RE = /[\u00c2\u00c3\u00e2][\u0080-\uffff]{1,2}|\ufffd/gu;

interface ItemGroup {
  readonly y: number;
  readonly items: readonly PdfTextItem[];
}

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

function replacementCount(text: string): number {
  return [...text].filter((char) => char === REPLACEMENT_CHAR).length;
}

function introducesReplacement(original: string, decoded: string): boolean {
  return replacementCount(decoded) > replacementCount(original);
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
  const viable = candidates.filter(
    (candidate) =>
      originalScore - garbageScore(candidate.text) >= MIN_REMAP_IMPROVEMENT &&
      !introducesReplacement(text, candidate.text)
  );
  return viable.toSorted((a, b) => garbageScore(a.text) - garbageScore(b.text))[0] ?? null;
}

function decideRecovery(text: string): RecoveryDecision {
  const trimmed = text.trim();
  if (trimmed.length < MIN_GARBLED_CHARS) return { kind: 'pass' };
  const originalScore = garbageScore(trimmed);
  if (originalScore < GARBLED_SCORE_THRESHOLD) return { kind: 'pass' };
  const remapped = bestRemap(text, originalScore);
  return remapped ?? { kind: 'unrecoverable' };
}

function compareItemPosition(a: PdfTextItem, b: PdfTextItem): number {
  const yDelta = b.y - a.y;
  return Math.abs(yDelta) <= ITEM_Y_TOLERANCE ? a.x - b.x : yDelta;
}

function itemGap(prev: PdfTextItem, next: PdfTextItem): number {
  return next.x - (prev.x + prev.width);
}

function shouldStartGroup(current: ItemGroup, item: PdfTextItem): boolean {
  const last = current.items.at(-1);
  if (Math.abs(current.y - item.y) > ITEM_Y_TOLERANCE) return true;
  return last !== undefined && itemGap(last, item) > ITEM_GROUP_GAP;
}

function appendItemGroup(groups: readonly ItemGroup[], item: PdfTextItem): readonly ItemGroup[] {
  const current = groups.at(-1);
  if (current === undefined || shouldStartGroup(current, item)) {
    return [...groups, { y: item.y, items: [item] }];
  }
  return [...groups.slice(0, -1), { ...current, items: [...current.items, item] }];
}

function itemGroups(items: readonly PdfTextItem[]): readonly ItemGroup[] {
  return [...items].sort(compareItemPosition).reduce<readonly ItemGroup[]>(appendItemGroup, []);
}

function groupText(group: ItemGroup): string {
  return group.items.map((item) => item.str).join('');
}

function mergedGroupItem(group: ItemGroup, text: string): PdfTextItem | null {
  const first = group.items[0];
  if (first === undefined) return null;
  const right = Math.max(...group.items.map((item) => item.x + item.width));
  return { ...first, str: text, width: Math.max(0, right - first.x) };
}

function remapItemGroup(group: ItemGroup, sourceEncoding: string): readonly PdfTextItem[] {
  const original = groupText(group);
  const decoded = decodeCandidate(original, sourceEncoding);
  if (decoded === null || introducesReplacement(original, decoded)) return group.items;
  const merged = mergedGroupItem(group, decoded);
  return merged === null ? group.items : [merged];
}

function remapPage(page: PdfPageText, decision: RemapDecision): PdfPageText {
  return {
    ...page,
    text: decision.text,
    items: itemGroups(page.items).flatMap((group) => remapItemGroup(group, decision.encoding)),
  };
}

function remappedLineHint(
  pageNumbers: readonly number[],
  decisions: readonly RemapDecision[]
): string {
  const pages = `pages ${pageNumbers.join(', ')}`;
  // Pages can recover with different source encodings/fingerprints, so report the
  // distinct set rather than attributing every page to the last decision seen.
  const variants = [...new Set(decisions.map((d) => `${d.encoding} (${d.fingerprint})`))];
  return `${pages}: ${variants.join('; ')} bytes decoded as UTF-8`;
}

function unrecoverableLineHint(pageNumbers: readonly number[]): string {
  return `pages ${pageNumbers.join(', ')}: detected symbol-heavy text with no stable remap`;
}

export function recoverPdfFontEncoding(pages: readonly PdfPageText[]): PdfFontEncodingRecovery {
  const remapped: number[] = [];
  const remapDecisions: RemapDecision[] = [];
  const unrecoverable: number[] = [];
  const recoveredPages = pages.map((page) => {
    const decision = decideRecovery(page.text);
    if (decision.kind === 'pass') return page;
    if (decision.kind === 'unrecoverable') {
      unrecoverable.push(page.pageNumber);
      return page;
    }
    remapped.push(page.pageNumber);
    remapDecisions.push(decision);
    return remapPage(page, decision);
  });
  const warnings: ParseWarning[] = [];
  if (remapped.length > 0) {
    warnings.push(
      warning('pdf-font-encoding-remapped', remappedLineHint(remapped, remapDecisions))
    );
  }
  if (unrecoverable.length > 0) {
    warnings.push(warning('pdf-font-encoding-unrecoverable', unrecoverableLineHint(unrecoverable)));
  }
  return { pages: recoveredPages, warnings };
}
