import { ParserError } from '../error.js';
import {
  asRecord,
  createDocumentXmlParser,
  extractAttrStr,
  getAttrVal,
  getAttrNumVal,
  toArray,
} from './xml-utils.js';
import { parseParagraphSources } from './source-facts.js';
import type { SourceFacts } from '../../ast/types.js';
import type { DocxComment } from './comments.js';
import type { DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { ParagraphSource } from './source-facts.js';

// See createDocumentXmlParser (xml-utils) for the #22/#120 config rationale. The table
// extractor shares this exact config so their reused text/vanish helpers stay in lockstep.
const xmlParser = createDocumentXmlParser(['w:p', 'w:r', 'w:hyperlink']);

interface ParagraphFields {
  readonly styleId: string | undefined;
  readonly numId: number | undefined;
  readonly ilvl: number | undefined;
  readonly leftIndent: number | undefined;
  readonly outlineLvl: number | undefined;
  readonly jc: string | undefined;
  readonly sourceFacts: SourceFacts | undefined;
  readonly pageBreakBefore: boolean | undefined;
  readonly ownPageBreakBefore: boolean | undefined;
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
//
// Exported for reuse by header-footer-region.ts's paragraph-content scan (#306
// review): header/footer parts wrap runs in the exact same OOXML constructs, and a
// direct-children-only scan there silently dropped any hyperlink/tracked-change
// (w:ins/w:del)/content-control (w:sdt)-wrapped header or footer text, with no
// raw.unmodeled entry and no warning.
export function collectRuns(value: unknown, acc: Record<string, unknown>[]): void {
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

// Exported alongside isParagraphVanish for document.xml-scoped scanners (the table
// extractor, #293) that have no ordered-source text to fall back on. Collects runs at
// any depth via collectRuns — the SAME traversal isParagraphVanish uses — so a cell
// whose text sits inside a w:sdt content control (SpecR's own merge anchors) or a
// w:ins/w:del tracked-change wrapper is both classified AND retained with its text,
// never dropped. (extractText reads only direct + hyperlink runs, which suffices for
// the body path's `parseParagraphSources ?? extractText` fallback but would silently
// lose wrapped runs here, misclassifying a fully-hidden wrapped table as visible.)
export function extractParagraphText(para: Record<string, unknown>): string {
  const runs: Record<string, unknown>[] = [];
  collectRuns(para, runs);
  return runs.map(extractRunText).join('');
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
    ...(fields.pageBreakBefore !== undefined ? { pageBreakBefore: fields.pageBreakBefore } : {}),
    ...(fields.ownPageBreakBefore !== undefined
      ? { ownPageBreakBefore: fields.ownPageBreakBefore }
      : {}),
  };
}

// ADR-075: detects a manual page break (`<w:br w:type="page"/>`) within a single run.
// run['w:br'] is already `unknown` (run: Record<string, unknown>) so it is directly
// assignable to toArray<unknown>'s parameter — no cast needed. Handles all 3 verified
// parse shapes: object ({'@_w:type':'page'}), empty string '' (bare self-closing
// <w:br/>, NOT an object), and array (2+ sibling w:br in the same run).
function runHasPageBreak(run: Record<string, unknown>): boolean {
  const breaks = toArray<unknown>(run['w:br']);
  return breaks.some((br) => {
    const rec = asRecord(br);
    return rec !== undefined && extractAttrStr(rec, '@_w:type') === 'page';
  });
}

// ADR-075: reuses collectRuns (same traversal as allTextRunsVanish/extractParagraphText)
// so hyperlink-, w:ins/w:del-, and w:sdt-wrapped runs are covered identically. Multiple
// page breaks in one paragraph collapse to a single true — KNOWN AMBIGUITY: the parser
// has no richer positional model.
function paragraphHasPageBreak(raw: Record<string, unknown>): boolean {
  const runs: Record<string, unknown>[] = [];
  collectRuns(raw, runs);
  return runs.some(runHasPageBreak);
}

// ADR-075: guards index-0 (no predecessor) and the noUncheckedIndexedAccess lookback
// without a non-null assertion.
function previousParagraphHasPageBreak(
  rawParagraphs: readonly Record<string, unknown>[],
  index: number
): boolean {
  if (index === 0) return false;
  const prev = rawParagraphs[index - 1];
  return prev !== undefined && paragraphHasPageBreak(prev);
}

// ADR-075: a manual page break appears in a source .docx in TWO forms, and both
// must be captured. The first is a `w:br type="page"` run at the end of the
// PRECEDING paragraph (Word's "Insert → Page Break"), handled by
// previousParagraphHasPageBreak. The second — this function — is the paragraph-
// level `w:pageBreakBefore` property ON the paragraph that begins the new page,
// produced by Word's Paragraph dialog → "Line and Page Breaks" → "Page break
// before" and set by many heading styles. It maps directly to
// `meta.pageBreakBefore` (and is also the exact property the generator re-emits).
// CT_OnOff toggle semantics: element present === on, unless an explicit falsey
// `w:val` (false/0/off) turns it off. The property is EFFECTIVE, not only local
// (CodeRabbit #497): a heading style commonly supplies it from styles.xml with
// no local pPr key at all, so direct formatting wins when present (including an
// explicit local false disabling a style-supplied break), else the selected
// w:pStyle's basedOn-resolved value (StyleMap.pageBreakStyleIds) decides.
function ownPageBreakBefore(
  pPr: Record<string, unknown> | undefined,
  styleId: string | undefined,
  styleMap: StyleMap
): boolean {
  if (pPr && 'w:pageBreakBefore' in pPr) {
    const val = getAttrVal(pPr['w:pageBreakBefore']);
    return val !== 'false' && val !== '0' && val !== 'off';
  }
  return styleId !== undefined && styleMap.pageBreakStyleIds?.has(styleId) === true;
}

function parseParagraph(
  raw: Record<string, unknown>,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  source: ParagraphSource | undefined,
  pageBreakBefore: boolean
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
    // Kept as two distinct signals — buildTree treats them differently across an
    // interposed body object (predecessor-lookback can be misattributed; the
    // paragraph's own property never is). See ADR-075 decision 8 and page-break.ts.
    pageBreakBefore: pageBreakBefore ? true : undefined,
    ownPageBreakBefore: ownPageBreakBefore(pPr, styleId, styleMap) ? true : undefined,
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

  const paragraphSources = parseParagraphSources(xml, commentsById, styleMap);
  const rawParagraphs = toArray<Record<string, unknown>>(
    body['w:p'] as readonly Record<string, unknown>[] | undefined
  );
  return rawParagraphs.map((p, index) =>
    parseParagraph(
      p,
      numberingMap,
      styleMap,
      paragraphSources[index],
      previousParagraphHasPageBreak(rawParagraphs, index)
    )
  );
}
