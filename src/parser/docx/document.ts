import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { extractAttrStr, getAttrVal, getAttrNumVal, toArray } from './xml-utils.js';
import type { DocxParagraph, NumberingMap } from './types.js';

// Entity audit (issue #22): fxp v5 does not resolve custom or recursive entity declarations
// — undefined/recursive &refs; are returned verbatim, not expanded (no billion-laughs risk).
// processEntities: true is required: OOXML text content uses &amp; &lt; &gt; for ampersands
// and angle brackets; setting false would corrupt those characters in paragraph text.
// trimValues: false preserves trailing/leading spaces in w:t text nodes — trimming would
// corrupt concatenated paragraph text across adjacent runs.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: false,
  isArray: (name) => ['w:p', 'w:r', 'w:hyperlink'].includes(name),
});

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

function parseParagraph(raw: Record<string, unknown>, numberingMap: NumberingMap): DocxParagraph {
  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const styleVal = pPr ? getAttrVal(pPr['w:pStyle']) : '';
  const styleId = styleVal || undefined;
  const { numId, ilvl } = resolveNumPr(pPr, styleId, numberingMap);
  const leftIndent = resolveLeftIndent(pPr);
  const outlineLvl = resolveOutlineLvl(pPr);
  const para: DocxParagraph = {
    text: extractText(raw),
    isVanish: resolveIsVanish(pPr),
  };
  return {
    ...para,
    ...(styleId !== undefined ? { styleId } : {}),
    ...(numId !== undefined ? { numId } : {}),
    ...(ilvl !== undefined ? { ilvl } : {}),
    ...(leftIndent !== undefined ? { leftIndent } : {}),
    ...(outlineLvl !== undefined ? { outlineLvl } : {}),
  };
}

export function parseDocument(xml: string, numberingMap: NumberingMap): DocxParagraph[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse word/document.xml', { cause: err });
  }

  const doc = (parsed as Record<string, unknown>)['w:document'] as
    | Record<string, unknown>
    | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  if (!body) throw new ParserError('word/document.xml missing w:body element');

  return toArray<Record<string, unknown>>(
    body['w:p'] as readonly Record<string, unknown>[] | undefined
  ).map((p) => parseParagraph(p, numberingMap));
}
