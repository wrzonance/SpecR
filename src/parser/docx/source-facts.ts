import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { asRecord, extractAttrStr } from './xml-utils.js';
import type { SourceColorFact, SourceCommentFact, SourceFacts } from '../../ast/types.js';
import type { DocxComment } from './comments.js';

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

interface ColorSpan {
  readonly color: string;
  readonly start: number;
  readonly end: number;
}

interface InlineParagraph {
  readonly text: string;
  readonly markers: readonly CommentMarker[];
  readonly colorSpans: readonly ColorSpan[];
}

interface InlineState {
  text: string;
  readonly markers: CommentMarker[];
  readonly colorSpans: ColorSpan[];
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

export interface ParagraphSource {
  readonly text: string;
  readonly sourceFacts?: SourceFacts;
}

function childNodes(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function hasElement(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function findElement(nodes: readonly unknown[], tag: string): Record<string, unknown> | undefined {
  for (const raw of nodes) {
    const record = asRecord(raw);
    if (record && hasElement(record, tag)) return record;
  }
  return undefined;
}

function elementName(record: Record<string, unknown>): string | null {
  return Object.keys(record).find((key) => key !== ':@' && key !== '#text') ?? null;
}

function orderedAttr(record: Record<string, unknown>, key: string): string {
  const attrs = asRecord(record[':@']);
  return attrs ? extractAttrStr(attrs, key) : '';
}

function markerKind(name: string): MarkerKind | null {
  if (name === 'w:commentRangeStart') return 'start';
  if (name === 'w:commentRangeEnd') return 'end';
  if (name === 'w:commentReference') return 'reference';
  return null;
}

function appendMarker(name: string, record: Record<string, unknown>, state: InlineState): void {
  const kind = markerKind(name);
  const id = orderedAttr(record, '@_w:id');
  if (kind && id) state.markers.push({ id, kind, offset: state.text.length });
}

function normalizeRunColor(value: string): string | null {
  const color = value.trim();
  const lower = color.toLowerCase();
  if (!color || lower === 'auto' || lower === '000000') return null;
  return /^[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : color;
}

function normalizeHighlight(value: string): string | null {
  const highlight = value.trim();
  if (!highlight || highlight.toLowerCase() === 'none') return null;
  return `highlight:${highlight}`;
}

function runColorTokens(runChildren: readonly unknown[]): readonly string[] {
  const rPr = findElement(runChildren, 'w:rPr');
  const props = rPr ? childNodes(rPr, 'w:rPr') : [];
  const color = findElement(props, 'w:color');
  const highlight = findElement(props, 'w:highlight');
  return [
    color ? normalizeRunColor(orderedAttr(color, '@_w:val')) : null,
    highlight ? normalizeHighlight(orderedAttr(highlight, '@_w:val')) : null,
  ].filter((token): token is string => token !== null);
}

function appendText(state: InlineState, text: string, colors: readonly string[]): void {
  const start = state.text.length;
  state.text += text;
  const end = state.text.length;
  if (start === end) return;
  colors.forEach((color) => state.colorSpans.push({ color, start, end }));
}

function collectInline(
  nodes: readonly unknown[],
  state: InlineState,
  colors: readonly string[] = []
): void {
  for (const raw of nodes) {
    const record = asRecord(raw);
    if (!record) continue;
    const text = record['#text'];
    if (typeof text === 'string') {
      appendText(state, text, colors);
      continue;
    }
    const name = elementName(record);
    if (!name) continue;
    appendMarker(name, record, state);
    const children = childNodes(record, name);
    collectInline(children, state, name === 'w:r' ? runColorTokens(children) : colors);
  }
}

function inlineParagraph(children: readonly unknown[]): InlineParagraph {
  const state: InlineState = { text: '', markers: [], colorSpans: [] };
  collectInline(children, state);
  return { text: state.text, markers: state.markers, colorSpans: state.colorSpans };
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
    if (!record || !hasElement(record, 'w:p')) return [];
    return [inlineParagraph(childNodes(record, 'w:p'))];
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
    appendFact(buckets, index, {
      author: comment.author,
      text: comment.text,
      anchor: [
        index === start.paragraphIndex ? start.offset : 0,
        index === end.paragraphIndex ? end.offset : paragraph.text.length,
      ],
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

function mergeSpans(spans: readonly ColorSpan[]): readonly (readonly [number, number])[] {
  const merged: [number, number][] = [];
  spans.forEach((span) => {
    const last = merged.at(-1);
    if (last && last[1] === span.start) {
      merged[merged.length - 1] = [last[0], span.end];
      return;
    }
    merged.push([span.start, span.end]);
  });
  return merged;
}

function coveredLength(spans: readonly (readonly [number, number])[]): number {
  return spans.reduce((sum, span) => sum + span[1] - span[0], 0);
}

function colorFactsForParagraph(paragraph: InlineParagraph): readonly SourceColorFact[] {
  if (paragraph.text.length === 0) return [];
  const byColor = new Map<string, ColorSpan[]>();
  paragraph.colorSpans.forEach((span) => {
    byColor.set(span.color, [...(byColor.get(span.color) ?? []), span]);
  });
  return [...byColor.entries()].map(([color, spans]) => {
    const merged = mergeSpans(spans);
    return { color, coverage: coveredLength(merged) / paragraph.text.length, spans: merged };
  });
}

function makeSourceFacts(
  comments: readonly SourceCommentFact[],
  colors: readonly SourceColorFact[]
): SourceFacts | undefined {
  if (comments.length === 0 && colors.length === 0) return undefined;
  return {
    ...(comments.length > 0 ? { comments } : {}),
    ...(colors.length > 0 ? { colors } : {}),
  };
}

function buildSourceFactsByParagraph(
  paragraphs: readonly InlineParagraph[],
  commentsById: ReadonlyMap<string, DocxComment>
): readonly (SourceFacts | undefined)[] {
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

  return paragraphs.map((paragraph, index) =>
    makeSourceFacts(buckets[index] ?? [], colorFactsForParagraph(paragraph))
  );
}

export function parseParagraphSources(
  xml: string,
  commentsById: ReadonlyMap<string, DocxComment>
): readonly ParagraphSource[] {
  let parsed: unknown;
  try {
    parsed = orderedXmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/document.xml', { cause: err });
  }
  const paragraphs = extractOrderedParagraphs(parsed);
  const sourceFacts = buildSourceFactsByParagraph(paragraphs, commentsById);
  return paragraphs.map((paragraph, index) => {
    const facts = sourceFacts[index];
    return facts ? { text: paragraph.text, sourceFacts: facts } : { text: paragraph.text };
  });
}
