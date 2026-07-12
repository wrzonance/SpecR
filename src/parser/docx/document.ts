import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { extractAttrStr, getAttrVal, getAttrNumVal, toArray } from './xml-utils.js';
import { parseParagraphSources } from './source-facts.js';
import type { SourceFacts } from '../../ast/types.js';
import type { DocxComment } from './comments.js';
import type { DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { ParagraphSource } from './source-facts.js';

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

interface ParagraphFields {
  readonly styleId: string | undefined;
  readonly numId: number | undefined;
  readonly ilvl: number | undefined;
  readonly leftIndent: number | undefined;
  readonly outlineLvl: number | undefined;
  readonly jc: string | undefined;
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

export function extractText(para: Record<string, unknown>): string {
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

// Effective paragraph alignment (w:jc @w:val), direct pPr first, then the paragraph
// style's basedOn-resolved alignment — Word commonly stores a title's centering in the
// style, not the paragraph (Codex adversarial review). A centered/right-aligned
// paragraph's leftIndent is horizontal positioning, not outline depth; the inference
// engine (Signal 5) reads this to avoid promoting a centered title to a spurious pr node.
function resolveJustification(
  pPr: Record<string, unknown> | undefined,
  styleId: string | undefined,
  styleMap: StyleMap
): string | undefined {
  const direct = pPr ? getAttrVal(pPr['w:jc']) : '';
  if (direct) return direct;
  return styleId ? styleMap.resolvedJc.get(styleId) : undefined;
}

function runIsVanish(
  run: Record<string, unknown>,
  vanishCharStyleIds: ReadonlySet<string>
): boolean {
  const rPr = run['w:rPr'];
  if (typeof rPr === 'object' && rPr !== null) {
    const rec = rPr as Record<string, unknown>;
    if ('w:vanish' in rec) return true;
    const rStyle = getAttrVal(rec['w:rStyle']);
    if (rStyle && vanishCharStyleIds.has(rStyle)) return true;
  }
  return false;
}

// Runs nest inside hyperlinks, tracked-change wrappers (w:ins/w:del), and content
// controls (w:sdt) — the same wrappers parseParagraphSources walks to extract text,
// and the wrapper SpecR's own generator emits (w:sdt UUID anchors). Collect runs at
// any depth so a fully-hidden wrapped paragraph is still detected (Codex #295). Skip
// w:rPr/w:pPr — property elements carry the paragraph mark, not content runs.
function collectRuns(value: unknown, acc: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRuns(item, acc);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'w:rPr' || key === 'w:pPr') continue;
    if (key === 'w:r') {
      acc.push(
        ...toArray<Record<string, unknown>>(child as readonly Record<string, unknown>[] | undefined)
      );
      continue;
    }
    collectRuns(child, acc);
  }
}

function allTextRunsVanish(
  raw: Record<string, unknown>,
  vanishCharStyleIds: ReadonlySet<string>
): boolean {
  const runs: Record<string, unknown>[] = [];
  collectRuns(raw, runs);
  const textRuns = runs.filter((r) => extractRunText(r).length > 0);
  if (textRuns.length === 0) return false;
  return textRuns.every((r) => runIsVanish(r, vanishCharStyleIds));
}

function paragraphMarkVanish(pPr: Record<string, unknown> | undefined): boolean {
  const raw = pPr?.['w:rPr'];
  if (raw === null || typeof raw !== 'object') return false;
  return 'w:vanish' in (raw as Record<string, unknown>);
}

function resolveParagraphVanish(
  raw: Record<string, unknown>,
  pPr: Record<string, unknown> | undefined,
  styleId: string | undefined,
  styleMap: StyleMap
): boolean {
  if (paragraphMarkVanish(pPr)) return true;
  if (styleId && styleMap.vanishStyleIds.has(styleId)) return true;
  return allTextRunsVanish(raw, styleMap.vanishCharStyleIds);
}

// Exported so other document.xml-scoped scanners (e.g. the table extractor, #293) can
// resolve a raw paragraph node's hiddenness through the same 3-signal resolution
// (paragraph-mark, paragraph-style, run/char-style) as ordinary body paragraphs,
// instead of re-implementing vanish detection. Mirrors parseParagraph's own pPr/styleId
// extraction verbatim — this is a pure delegation, not a new code path.
export function isParagraphVanish(raw: Record<string, unknown>, styleMap: StyleMap): boolean {
  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const styleVal = pPr ? getAttrVal(pPr['w:pStyle']) : '';
  const styleId = styleVal || undefined;
  return resolveParagraphVanish(raw, pPr, styleId, styleMap);
}

function addParagraphFields(base: DocxParagraph, fields: ParagraphFields): DocxParagraph {
  return {
    ...base,
    ...(fields.styleId !== undefined ? { styleId: fields.styleId } : {}),
    ...(fields.numId !== undefined ? { numId: fields.numId } : {}),
    ...(fields.ilvl !== undefined ? { ilvl: fields.ilvl } : {}),
    ...(fields.leftIndent !== undefined ? { leftIndent: fields.leftIndent } : {}),
    ...(fields.outlineLvl !== undefined ? { outlineLvl: fields.outlineLvl } : {}),
    ...(fields.jc !== undefined ? { jc: fields.jc } : {}),
    ...(fields.sourceFacts !== undefined ? { sourceFacts: fields.sourceFacts } : {}),
  };
}

function parseParagraph(
  raw: Record<string, unknown>,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  source: ParagraphSource | undefined
): DocxParagraph {
  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const styleVal = pPr ? getAttrVal(pPr['w:pStyle']) : '';
  const styleId = styleVal || undefined;
  const { numId, ilvl } = resolveNumPr(pPr, styleId, numberingMap);
  const leftIndent = resolveLeftIndent(pPr);
  const outlineLvl = resolveOutlineLvl(pPr);
  const jc = resolveJustification(pPr, styleId, styleMap);
  const para: DocxParagraph = {
    text: source?.text ?? extractText(raw),
    isVanish: resolveParagraphVanish(raw, pPr, styleId, styleMap),
  };
  return addParagraphFields(para, {
    styleId,
    numId,
    ilvl,
    leftIndent,
    outlineLvl,
    jc,
    sourceFacts: source?.sourceFacts,
  });
}

export function parseDocument(
  xml: string,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  commentsById: ReadonlyMap<string, DocxComment> = new Map()
): DocxParagraph[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/document.xml', {
      code: 'DOCX_MISSING_DOCUMENT',
      cause: err,
    });
  }

  const doc = (parsed as Record<string, unknown>)['w:document'] as
    | Record<string, unknown>
    | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  if (!body) {
    throw new ParserError('word/document.xml missing w:body element', {
      code: 'DOCX_MISSING_DOCUMENT',
    });
  }

  const paragraphSources = parseParagraphSources(xml, commentsById);
  return toArray<Record<string, unknown>>(
    body['w:p'] as readonly Record<string, unknown>[] | undefined
  ).map((p, index) => parseParagraph(p, numberingMap, styleMap, paragraphSources[index]));
}
