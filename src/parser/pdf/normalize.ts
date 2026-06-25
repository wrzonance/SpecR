import { parseSectionNumberCandidate, sectionNumberFragment } from '../../lib/section-number.js';

export interface PdfTextItem {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hasEOL?: boolean;
}

export interface PdfPageText {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly items: readonly PdfTextItem[];
}

interface PdfLine {
  readonly pageNumber: number;
  readonly pageHeight: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

interface LineDraft {
  readonly pageNumber: number;
  readonly pageHeight: number;
  readonly y: number;
  readonly items: readonly PdfTextItem[];
}

const LINE_Y_TOLERANCE = 3;
const MIN_COLUMN_GAP = 120;
const FURNITURE_PAGE_MIN = 2;
const FURNITURE_BAND_RATIO = 0.1;
const SECTION_HEADING_RE = new RegExp(
  String.raw`^SECTION\s+${sectionNumberFragment()}(?:\s*[-–—]\s*(.*))?$`,
  'i'
);
const BARE_SECTION_HEADING_RE = new RegExp(
  String.raw`^${sectionNumberFragment()}\s*[-–—]\s*(.+)$`,
  'i'
);
const TEXTUAL_TITLE_RE = /[A-Za-z]/;

function comparePosition(a: PdfTextItem, b: PdfTextItem): number {
  const yDelta = b.y - a.y;
  return Math.abs(yDelta) <= LINE_Y_TOLERANCE ? a.x - b.x : yDelta;
}

function appendToDrafts(drafts: readonly LineDraft[], page: PdfPageText, item: PdfTextItem) {
  const current = drafts.at(-1);
  if (current === undefined || shouldStartLine(current, item)) {
    return [
      ...drafts,
      { pageNumber: page.pageNumber, pageHeight: page.height, y: item.y, items: [item] },
    ];
  }
  return [
    ...drafts.slice(0, -1),
    {
      ...current,
      items: [...current.items, item],
      y: (current.y * current.items.length + item.y) / (current.items.length + 1),
    },
  ];
}

function shouldStartLine(current: LineDraft, item: PdfTextItem): boolean {
  const lastItem = current.items.at(-1);
  if (Math.abs(current.y - item.y) > LINE_Y_TOLERANCE) return true;
  return lastItem !== undefined && itemGap(lastItem, item) > MIN_COLUMN_GAP;
}

function itemGap(prev: PdfTextItem, next: PdfTextItem): number {
  return next.x - (prev.x + prev.width);
}

function joinLineItems(items: readonly PdfTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  return sorted.reduce((text, item, index) => {
    const prev = sorted[index - 1];
    const gap = prev === undefined ? 0 : itemGap(prev, item);
    const separator = gap > 3 && !text.endsWith(' ') ? ' ' : '';
    return `${text}${separator}${item.str}`;
  }, '');
}

function draftToLine(draft: LineDraft): PdfLine {
  const xs = draft.items.map((item) => item.x);
  return {
    pageNumber: draft.pageNumber,
    pageHeight: draft.pageHeight,
    x: Math.min(...xs),
    y: draft.y,
    text: cleanLine(joinLineItems(draft.items)),
  };
}

function pageLines(page: PdfPageText): readonly PdfLine[] {
  const drafts = [...page.items]
    .filter((item) => item.str.trim() !== '')
    .sort(comparePosition)
    .reduce<readonly LineDraft[]>((acc, item) => appendToDrafts(acc, page, item), []);
  return drafts.map(draftToLine).filter((line) => line.text !== '');
}

function cleanLine(text: string): string {
  return text
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function furnitureKey(line: PdfLine): string {
  return line.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function isPageFurniture(line: PdfLine): boolean {
  const band = Math.max(36, line.pageHeight * FURNITURE_BAND_RATIO);
  return line.y >= line.pageHeight - band || line.y <= band;
}

function repeatedFurnitureKeys(lines: readonly PdfLine[]): ReadonlySet<string> {
  const pageSets = new Map<string, Set<number>>();
  for (const line of lines) {
    if (!isPageFurniture(line)) continue;
    const key = furnitureKey(line);
    pageSets.set(key, new Set([...(pageSets.get(key) ?? []), line.pageNumber]));
  }
  return new Set(
    [...pageSets.entries()]
      .filter(([, pages]) => pages.size >= FURNITURE_PAGE_MIN)
      .map(([key]) => key)
  );
}

function isSectionNumber(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return parseSectionNumberCandidate(raw, 'strong').ok;
}

function hasOptionalTitle(title: string | undefined): boolean {
  return title === undefined || TEXTUAL_TITLE_RE.test(title);
}

function isKeywordSectionHeading(text: string): boolean {
  const match = SECTION_HEADING_RE.exec(text.trim());
  return match !== null && isSectionNumber(match[1]) && hasOptionalTitle(match[2]);
}

function isBareSectionHeading(text: string): boolean {
  const match = BARE_SECTION_HEADING_RE.exec(text.trim());
  return match !== null && isSectionNumber(match[1]) && TEXTUAL_TITLE_RE.test(match[2] ?? '');
}

function isSectionHeading(text: string): boolean {
  return isKeywordSectionHeading(text) || isBareSectionHeading(text);
}

function filterContentLines(
  lines: readonly PdfLine[],
  furniture: ReadonlySet<string>
): readonly PdfLine[] {
  const keptSectionKeys = new Set<string>();
  return lines.filter((line) => {
    const key = furnitureKey(line);
    if (!furniture.has(key)) return true;
    if (!isSectionHeading(line.text) || keptSectionKeys.has(key)) return false;
    keptSectionKeys.add(key);
    return true;
  });
}

function columnSplit(lines: readonly PdfLine[]): number | null {
  const xs = [...new Set(lines.map((line) => Math.round(line.x)))].sort((a, b) => a - b);
  const gaps = xs
    .slice(1)
    .map((x, index) => ({ left: xs[index], right: x, gap: x - (xs[index] ?? x) }));
  const sortedGaps = [...gaps].sort((a, b) => b.gap - a.gap);
  const largest = sortedGaps[0];
  if (largest === undefined || largest.left === undefined || largest.gap < MIN_COLUMN_GAP)
    return null;
  const split = largest.left + largest.gap / 2;
  const leftCount = lines.filter((line) => line.x < split).length;
  const rightCount = lines.length - leftCount;
  return leftCount >= 2 && rightCount >= 2 ? split : null;
}

function compareLineReadingOrder(a: PdfLine, b: PdfLine): number {
  const yDelta = b.y - a.y;
  return Math.abs(yDelta) <= LINE_Y_TOLERANCE ? a.x - b.x : yDelta;
}

function orderPageLines(lines: readonly PdfLine[]): readonly PdfLine[] {
  const split = columnSplit(lines);
  if (split === null) return [...lines].sort(compareLineReadingOrder);
  const left = lines.filter((line) => line.x < split).sort(compareLineReadingOrder);
  const right = lines.filter((line) => line.x >= split).sort(compareLineReadingOrder);
  return [...left, ...right];
}

function joinHyphenatedLines(lines: readonly string[]): string {
  return lines
    .reduce<readonly string[]>((acc, line) => {
      const previous = acc.at(-1);
      if (previous !== undefined && /[A-Za-z]-$/.test(previous) && /^[a-z]/.test(line)) {
        return [...acc.slice(0, -1), `${previous.slice(0, -1)}${line}`];
      }
      return [...acc, line];
    }, [])
    .join('\n');
}

export function normalizePdfText(pages: readonly PdfPageText[]): string {
  const lines = pages.flatMap(pageLines);
  const furniture = repeatedFurnitureKeys(lines);
  const contentLines = filterContentLines(lines, furniture);
  const orderedLines = pages.flatMap((page) =>
    orderPageLines(contentLines.filter((line) => line.pageNumber === page.pageNumber))
  );
  return joinHyphenatedLines(orderedLines.map((line) => line.text)).trim();
}
