import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { asRecord, extractAttrStr, getAttrVal, getAttrNumVal, toArray } from './xml-utils.js';
import type { SourceCommentFact, SourceFacts } from '../../ast/types.js';
import type { DocxComment } from './comments.js';
import type { DocxParagraph, NumberingMap } from './types.js';

// Entity audit (issue #22): fxp v5 does not resolve custom or recursive entity declarations
// — undefined/recursive &refs; are returned verbatim, not expanded (no billion-laughs risk).
// processEntities: true is required: OOXML text content uses &amp; &lt; &gt; for ampersands
// and angle brackets; setting false would corrupt those characters in paragraph text.
// trimValues: false preserves trailing/leading spaces in w:t text nodes — trimming would
// corrupt concatenated paragraph text across adjacent runs.
// parseTagValue: false keeps w:t text as strings (#120): fxp's default numeric coercion
// turns a bare-integer run (<w:t>9</w:t>) into the number 9, which extractRunText cannot
// read and silently drops — deleting digits from numbers Word split across runs, e.g.
// "09 91 26" stored as ["09 ", "9", "1 26"] rendered as "09 1 26".
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  isArray: (name) => ['w:p', 'w:r', 'w:hyperlink'].includes(name),
});

const orderedXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  preserveOrder: true,
});

type MarkerKind = 'start' | 'end' | 'reference';

interface CommentMarker {
  readonly id: string;
  readonly kind: MarkerKind;
  readonly offset: number;
}

interface InlineParagraph {
  readonly text: string;
  readonly markers: readonly CommentMarker[];
}

interface InlineState {
  text: string;
  readonly markers: CommentMarker[];
}

interface ActiveComment {
  readonly paragraphIndex: number;
  readonly offset: number;
}

interface CommentFactContext {
  readonly buckets: readonly SourceCommentFact[][];
  readonly paragraphs: readonly InlineParagraph[];
  readonly commentsById: ReadonlyMap<string, DocxComment>;
  readonly active: Map<string, ActiveComment>;
  readonly attached: Set<string>;
}

interface ParagraphFields {
  readonly styleId: string | undefined;
  readonly numId: number | undefined;
  readonly ilvl: number | undefined;
  readonly leftIndent: number | undefined;
  readonly outlineLvl: number | undefined;
  readonly sourceFacts: SourceFacts | undefined;
}

function extractRunText(run: Record<string, unknown>): string {
  const t = run['w:t'];
  if (typeof t === 'string') return t;
  if (typeof t === 'object' && t !== null && '#text' in t) {
    const val = (t as Record<string, string | undefined>)['#text'];
    return val ?? '';
  }
  return '';
}

function extractText(para: Record<string, unknown>): string {
  const directRuns = toArray<Record<string, unknown>>(
    para['w:r'] as readonly Record<string, unknown>[] | undefined
  );
  const linkRuns = toArray<Record<string, unknown>>(
    para['w:hyperlink'] as readonly Record<string, unknown>[] | undefined
  ).flatMap((h) =>
    toArray<Record<string, unknown>>(h['w:r'] as readonly Record<string, unknown>[] | undefined)
  );
  return [...directRuns, ...linkRuns].map(extractRunText).join('');
}

function childNodes(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function elementName(record: Record<string, unknown>): string | null {
  return Object.keys(record).find((key) => key !== ':@' && key !== '#text') ?? null;
}

function markerId(record: Record<string, unknown>): string {
  const attrs = asRecord(record[':@']);
  return attrs ? extractAttrStr(attrs, '@_w:id') : '';
}

function markerKind(name: string): MarkerKind | null {
  if (name === 'w:commentRangeStart') return 'start';
  if (name === 'w:commentRangeEnd') return 'end';
  if (name === 'w:commentReference') return 'reference';
  return null;
}

function appendMarker(name: string, record: Record<string, unknown>, state: InlineState): void {
  const kind = markerKind(name);
  const id = markerId(record);
  if (kind && id) {
    state.markers.push({ id, kind, offset: state.text.length });
  }
}

function collectInline(nodes: readonly unknown[], state: InlineState): void {
  for (const raw of nodes) {
    const record = asRecord(raw);
    if (!record) continue;
    const text = record['#text'];
    if (typeof text === 'string') {
      state.text += text;
      continue;
    }
    const name = elementName(record);
    if (!name) continue;
    appendMarker(name, record, state);
    collectInline(childNodes(record, name), state);
  }
}

function inlineParagraph(children: readonly unknown[]): InlineParagraph {
  const state: InlineState = { text: '', markers: [] };
  collectInline(children, state);
  return { text: state.text, markers: state.markers };
}

function findElementChildren(nodes: readonly unknown[], tag: string): readonly unknown[] {
  for (const raw of nodes) {
    const record = asRecord(raw);
    if (!record) continue;
    const children = childNodes(record, tag);
    if (children.length > 0) return children;
  }
  return [];
}

function extractOrderedParagraphs(parsed: unknown): readonly InlineParagraph[] {
  const root = Array.isArray(parsed) ? parsed : [];
  const document = findElementChildren(root, 'w:document');
  const body = findElementChildren(document, 'w:body');
  return body.flatMap((raw) => {
    const record = asRecord(raw);
    const children = record ? childNodes(record, 'w:p') : [];
    return children.length > 0 ? [inlineParagraph(children)] : [];
  });
}

function appendFact(
  buckets: readonly SourceCommentFact[][],
  index: number,
  fact: SourceCommentFact
): void {
  const bucket = buckets[index];
  if (bucket) bucket.push(fact);
}

function appendRangeFacts(
  buckets: readonly SourceCommentFact[][],
  paragraphs: readonly InlineParagraph[],
  comment: DocxComment,
  start: ActiveComment,
  end: ActiveComment
): void {
  for (let index = start.paragraphIndex; index <= end.paragraphIndex; index += 1) {
    const paragraph = paragraphs[index];
    if (!paragraph) continue;
    const anchorStart = index === start.paragraphIndex ? start.offset : 0;
    const anchorEnd = index === end.paragraphIndex ? end.offset : paragraph.text.length;
    appendFact(buckets, index, {
      author: comment.author,
      text: comment.text,
      anchor: [anchorStart, anchorEnd],
    });
  }
}

function handleStartMarker(
  marker: CommentMarker,
  paragraphIndex: number,
  context: CommentFactContext
): void {
  if (marker.kind !== 'start') return;
  context.active.set(marker.id, { paragraphIndex, offset: marker.offset });
}

function handleEndMarker(
  marker: CommentMarker,
  paragraphIndex: number,
  context: CommentFactContext
): void {
  if (marker.kind !== 'end') return;
  const start = context.active.get(marker.id);
  const comment = context.commentsById.get(marker.id);
  if (start && comment) {
    appendRangeFacts(context.buckets, context.paragraphs, comment, start, {
      paragraphIndex,
      offset: marker.offset,
    });
    context.attached.add(marker.id);
  }
  context.active.delete(marker.id);
}

function handleReferenceMarker(
  marker: CommentMarker,
  paragraphIndex: number,
  context: CommentFactContext
): void {
  if (marker.kind !== 'reference' || context.attached.has(marker.id)) return;
  const comment = context.commentsById.get(marker.id);
  if (!comment) return;
  appendFact(context.buckets, paragraphIndex, {
    author: comment.author,
    text: comment.text,
    anchor: [marker.offset, marker.offset],
  });
}

function handleMarker(
  marker: CommentMarker,
  paragraphIndex: number,
  context: CommentFactContext
): void {
  handleStartMarker(marker, paragraphIndex, context);
  handleEndMarker(marker, paragraphIndex, context);
  handleReferenceMarker(marker, paragraphIndex, context);
}

function buildSourceFactsByParagraph(
  paragraphs: readonly InlineParagraph[],
  commentsById: ReadonlyMap<string, DocxComment>
): readonly (SourceFacts | undefined)[] {
  if (commentsById.size === 0) return [];
  const buckets = paragraphs.map((): SourceCommentFact[] => []);
  const context: CommentFactContext = {
    buckets,
    paragraphs,
    commentsById,
    active: new Map(),
    attached: new Set(),
  };

  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const marker of paragraph.markers) {
      handleMarker(marker, paragraphIndex, context);
    }
  });

  return buckets.map((comments) => (comments.length > 0 ? { comments } : undefined));
}

interface NumPrResult {
  readonly numId: number | undefined;
  readonly ilvl: number | undefined;
}

function resolveNumPr(
  pPr: Record<string, unknown> | undefined,
  styleId: string | undefined,
  numberingMap: NumberingMap
): NumPrResult {
  const ownNumPr = pPr?.['w:numPr'] as Record<string, unknown> | undefined;
  if (ownNumPr) {
    return {
      numId: getAttrNumVal(ownNumPr['w:numId']),
      ilvl: getAttrNumVal(ownNumPr['w:ilvl']),
    };
  }
  if (styleId) {
    const inherited = numberingMap.pStyleToNumId.get(styleId);
    if (inherited !== undefined) {
      return { numId: inherited, ilvl: numberingMap.pStyleToIlvl.get(styleId) };
    }
  }
  return { numId: undefined, ilvl: undefined };
}

function resolveLeftIndent(pPr: Record<string, unknown> | undefined): number | undefined {
  const ind = pPr?.['w:ind'] as Record<string, unknown> | undefined;
  if (!ind) return undefined;
  const leftStr = extractAttrStr(ind, '@_w:left');
  if (!leftStr) return undefined;
  const n = parseInt(leftStr, 10);
  return isNaN(n) ? undefined : n;
}

function resolveOutlineLvl(pPr: Record<string, unknown> | undefined): number | undefined {
  if (!pPr) return undefined;
  const str = getAttrVal(pPr['w:outlineLvl']);
  if (!str) return undefined;
  const n = parseInt(str, 10);
  return isNaN(n) ? undefined : n;
}

function resolveIsVanish(pPr: Record<string, unknown> | undefined): boolean {
  const raw = pPr?.['w:rPr'];
  if (raw === null || typeof raw !== 'object') return false;
  return 'w:vanish' in (raw as Record<string, unknown>);
}

function addParagraphFields(base: DocxParagraph, fields: ParagraphFields): DocxParagraph {
  return {
    ...base,
    ...(fields.styleId !== undefined ? { styleId: fields.styleId } : {}),
    ...(fields.numId !== undefined ? { numId: fields.numId } : {}),
    ...(fields.ilvl !== undefined ? { ilvl: fields.ilvl } : {}),
    ...(fields.leftIndent !== undefined ? { leftIndent: fields.leftIndent } : {}),
    ...(fields.outlineLvl !== undefined ? { outlineLvl: fields.outlineLvl } : {}),
    ...(fields.sourceFacts !== undefined ? { sourceFacts: fields.sourceFacts } : {}),
  };
}

function parseParagraph(
  raw: Record<string, unknown>,
  numberingMap: NumberingMap,
  inline: InlineParagraph | undefined,
  sourceFacts: SourceFacts | undefined
): DocxParagraph {
  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const styleVal = pPr ? getAttrVal(pPr['w:pStyle']) : '';
  const styleId = styleVal || undefined;
  const { numId, ilvl } = resolveNumPr(pPr, styleId, numberingMap);
  const leftIndent = resolveLeftIndent(pPr);
  const outlineLvl = resolveOutlineLvl(pPr);
  const para: DocxParagraph = {
    text: inline?.text ?? extractText(raw),
    isVanish: resolveIsVanish(pPr),
  };
  return addParagraphFields(para, { styleId, numId, ilvl, leftIndent, outlineLvl, sourceFacts });
}

export function parseDocument(
  xml: string,
  numberingMap: NumberingMap,
  commentsById: ReadonlyMap<string, DocxComment> = new Map()
): DocxParagraph[] {
  let parsed: unknown;
  let orderedParsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
    orderedParsed = orderedXmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/document.xml', { cause: err });
  }

  const doc = (parsed as Record<string, unknown>)['w:document'] as
    | Record<string, unknown>
    | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  if (!body) throw new ParserError('word/document.xml missing w:body element');

  const inlineParagraphs = extractOrderedParagraphs(orderedParsed);
  const sourceFactsByParagraph = buildSourceFactsByParagraph(inlineParagraphs, commentsById);
  return toArray<Record<string, unknown>>(
    body['w:p'] as readonly Record<string, unknown>[] | undefined
  ).map((p, index) =>
    parseParagraph(p, numberingMap, inlineParagraphs[index], sourceFactsByParagraph[index])
  );
}
