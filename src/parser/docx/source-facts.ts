import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { scanChoiceTokens } from './choice-tokens.js';
import { isCommentClosed } from './comment-closure.js';
import {
  effectiveEmphasisForParagraph,
  sourcePropertiesForRun,
  type RunSourceProperties,
} from './run-source-facts.js';
import { asRecord, extractAttrStr } from './xml-utils.js';
import type {
  SourceChoiceTokenFact,
  SourceColorFact,
  SourceCommentFact,
  SourceEmphasisFact,
  SourceFacts,
} from '../../ast/types.js';
import type { DocxComment } from './comments.js';
import type { StyleMap } from './types.js';

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
  readonly emphasis: readonly SourceEmphasisFact[];
}

interface InlineState {
  text: string;
  readonly markers: CommentMarker[];
  readonly colorSpans: ColorSpan[];
  readonly emphasis: SourceEmphasisFact[];
  readonly styleMap: StyleMap;
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

function appendText(state: InlineState, text: string, properties: RunSourceProperties): void {
  const start = state.text.length;
  state.text += text;
  const end = state.text.length;
  if (start === end) return;
  properties.colors.forEach((color) => state.colorSpans.push({ color, start, end }));
}

function appendEmphasis(state: InlineState, start: number, properties: RunSourceProperties): void {
  const end = state.text.length;
  const text = state.text.slice(start, end);
  if (text.trim().length === 0) return;
  properties.emphasis.forEach((fact) => state.emphasis.push({ ...fact, text, span: [start, end] }));
}

// Formatting-property subtrees that must never contribute text content: a
// w:pPr > w:tabs > w:tab (a tab-STOP definition) would otherwise inject a phantom
// tab now that w:tab renders as whitespace. Mirrors merge/extract.ts PROPERTY_TAGS.
const PROPERTY_TAGS = new Set(['w:pPr', 'w:rPr', 'w:sdtPr', 'w:sdtEndPr']);

// Handle a non-#text element that contributes text WITHOUT recursion (or that must be
// skipped entirely). Returns true when the element was consumed here.
//   • property subtrees (w:pPr/w:rPr/…) never contribute text.
//   • a run's <w:tab/> is real whitespace in the rendered text — often the sole delimiter
//     in hand-authored outlines ("1.1<tab>SUMMARY", "A.<tab>General"). Dropping it
//     de-spaced the number into the title ("1.1SUMMARY"), defeating every Signal-4 text
//     pattern (all require \s after the number) and the outline-strip logic, and silently
//     concatenated words across the corpus ("wireless<tab>signals"). Emit a tab so those
//     paragraphs classify and strip as authored. Uncolored (a structural delimiter carries
//     no ink), so run color coverage is unaffected. Mirrors merge/extract.ts's w:tab → '\t'
//     (w:br/w:cr line breaks are a separate word-joining concern, left as-is here).
function collectLayoutElement(name: string, state: InlineState): boolean {
  if (PROPERTY_TAGS.has(name)) return true;
  if (name === 'w:tab') {
    state.text += '\t';
    return true;
  }
  return false;
}

function collectOne(
  record: Record<string, unknown>,
  state: InlineState,
  properties: RunSourceProperties
): void {
  const text = record['#text'];
  if (typeof text === 'string') {
    appendText(state, text, properties);
    return;
  }
  const name = elementName(record);
  if (!name) return;
  if (collectLayoutElement(name, state)) return;
  appendMarker(name, record, state);
  const children = childNodes(record, name);
  if (name === 'w:r') {
    const runProperties = sourcePropertiesForRun(children, properties.effective, state.styleMap);
    const start = state.text.length;
    collectInline(children, state, runProperties);
    appendEmphasis(state, start, runProperties);
    return;
  }
  collectInline(children, state, properties);
}

function collectInline(
  nodes: readonly unknown[],
  state: InlineState,
  properties: RunSourceProperties
): void {
  for (const raw of nodes) {
    const record = asRecord(raw);
    if (record) collectOne(record, state, properties);
  }
}

function inlineParagraph(children: readonly unknown[], styleMap: StyleMap): InlineParagraph {
  const effective = effectiveEmphasisForParagraph(children, styleMap);
  const state: InlineState = { text: '', markers: [], colorSpans: [], emphasis: [], styleMap };
  collectInline(children, state, { colors: [], emphasis: [], effective });
  return {
    text: state.text,
    markers: state.markers,
    colorSpans: state.colorSpans,
    emphasis: state.emphasis,
  };
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

function extractOrderedParagraphs(parsed: unknown, styleMap: StyleMap): readonly InlineParagraph[] {
  const root = Array.isArray(parsed) ? parsed : [];
  const document = findElementChildren(root, 'w:document');
  const body = findElementChildren(document, 'w:body');
  return body.flatMap((raw) => {
    const record = asRecord(raw);
    if (!record || !hasElement(record, 'w:p')) return [];
    return [inlineParagraph(childNodes(record, 'w:p'), styleMap)];
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
  const closed = isCommentClosed(comment);
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
      closed,
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
    closed: isCommentClosed(comment),
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
  colors: readonly SourceColorFact[],
  choiceTokens: readonly SourceChoiceTokenFact[],
  emphasis: readonly SourceEmphasisFact[]
): SourceFacts | undefined {
  if (
    comments.length === 0 &&
    colors.length === 0 &&
    choiceTokens.length === 0 &&
    emphasis.length === 0
  ) {
    return undefined;
  }
  return {
    ...(comments.length > 0 ? { comments } : {}),
    ...(colors.length > 0 ? { colors } : {}),
    ...(choiceTokens.length > 0 ? { choiceTokens } : {}),
    ...(emphasis.length > 0 ? { emphasis } : {}),
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
    makeSourceFacts(
      buckets[index] ?? [],
      colorFactsForParagraph(paragraph),
      scanChoiceTokens(paragraph.text),
      paragraph.emphasis
    )
  );
}

export function parseParagraphSources(
  xml: string,
  commentsById: ReadonlyMap<string, DocxComment>,
  styleMap: StyleMap
): readonly ParagraphSource[] {
  let parsed: unknown;
  try {
    parsed = orderedXmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/document.xml', { cause: err });
  }
  const paragraphs = extractOrderedParagraphs(parsed, styleMap);
  const sourceFacts = buildSourceFactsByParagraph(paragraphs, commentsById);
  return paragraphs.map((paragraph, index) => {
    const facts = sourceFacts[index];
    return facts ? { text: paragraph.text, sourceFacts: facts } : { text: paragraph.text };
  });
}
