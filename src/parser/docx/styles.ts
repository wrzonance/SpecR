/*
 * Portions of this file are a TypeScript port of logic from Clippit's
 * `ListItemRetriever` (originally C#), which is itself derived from Eric
 * White's Open-Xml-PowerTools. The `numId=0` basedOn-chain-stop sentinel
 * and the surrounding style-inheritance resolution come from that
 * upstream.
 *
 *   - https://github.com/sergey-tihon/Clippit (MIT)
 *   - https://github.com/EricWhiteDev/Open-Xml-PowerTools (MIT, predecessor)
 *
 * Upstream copyright preserved in the repo-root NOTICES file.
 */

import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { getAttrVal, getAttrNumVal, extractAttrStr, toArray } from './xml-utils.js';
import type { StyleInfo, StyleMap, StyleNumPr } from './types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => name === 'w:style',
});

const MAX_BASED_ON_DEPTH = 20; // cycle guard

type NumPrResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'suppressed' }
  | { readonly kind: 'active'; readonly numPr: StyleNumPr };

// Clippit ListItemRetriever: numId=0 explicitly suppresses numbering and STOPS basedOn chain.
// Must distinguish from "no w:numPr element at all" (which continues the chain).
function parseNumPr(pPr: Record<string, unknown>): NumPrResult {
  const numPr = pPr['w:numPr'] as Record<string, unknown> | undefined;
  if (!numPr) return { kind: 'absent' };
  const numId = getAttrNumVal(numPr['w:numId']);
  if (numId === 0) return { kind: 'suppressed' };
  const ilvl = getAttrNumVal(numPr['w:ilvl']);
  return { kind: 'active', numPr: { numId, ilvl } };
}

function asObject(val: unknown): Record<string, unknown> | undefined {
  return val !== null && typeof val === 'object' ? (val as Record<string, unknown>) : undefined;
}

function parseVanish(raw: Record<string, unknown>): boolean {
  const pPr = asObject(raw['w:pPr']);
  const pRpr = asObject(pPr?.['w:rPr']);
  const rPr = asObject(raw['w:rPr']);
  return (pRpr !== undefined && 'w:vanish' in pRpr) || (rPr !== undefined && 'w:vanish' in rPr);
}

function parseOutlineLvl(pPr: Record<string, unknown> | undefined): number | undefined {
  if (!pPr) return undefined;
  const rawVal = getAttrVal(pPr['w:outlineLvl']);
  if (!rawVal) return undefined;
  const n = parseInt(rawVal, 10);
  return isNaN(n) ? undefined : n;
}

function resolvedName(raw: Record<string, unknown>, fallback: string): string {
  return getAttrVal(raw['w:name']) || fallback;
}

function numPrFields(result: NumPrResult): Pick<StyleInfo, 'numPr' | 'suppressesNumbering'> {
  if (result.kind === 'active') return { numPr: result.numPr };
  if (result.kind === 'suppressed') return { suppressesNumbering: true };
  return {};
}

function parseStyleInfo(raw: Record<string, unknown>): StyleInfo | null {
  const styleType = extractAttrStr(raw, '@_w:type') || 'paragraph';
  if (styleType !== 'paragraph') return null;
  const styleId = extractAttrStr(raw, '@_w:styleId');
  if (!styleId) return null;

  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const basedOn = getAttrVal(raw['w:basedOn']);
  const next = getAttrVal(raw['w:next']);
  const numPrResult = pPr ? parseNumPr(pPr) : ({ kind: 'absent' } as const);
  const outlineLvl = parseOutlineLvl(pPr);

  return {
    styleId,
    name: resolvedName(raw, styleId),
    ...(basedOn ? { basedOn } : {}),
    ...(next ? { next } : {}),
    ...numPrFields(numPrResult),
    ...(parseVanish(raw) ? { isVanish: true as const } : {}),
    ...(outlineLvl !== undefined ? { outlineLvl } : {}),
  };
}

function resolveNumPrChain(
  styleId: string,
  styles: ReadonlyMap<string, StyleInfo>,
  depth: number
): StyleNumPr | undefined {
  if (depth > MAX_BASED_ON_DEPTH) return undefined;
  const style = styles.get(styleId);
  if (!style) return undefined;
  if (style.suppressesNumbering) return undefined; // numId=0 stops chain (Clippit behavior)
  if (style.numPr) return style.numPr;
  if (style.basedOn) return resolveNumPrChain(style.basedOn, styles, depth + 1);
  return undefined;
}

export function buildStyleMap(xml: string): StyleMap {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse styles.xml', { cause: err });
  }

  const root = (parsed as Record<string, unknown>)['w:styles'] as
    | Record<string, unknown>
    | undefined;
  if (!root) return { styles: new Map(), resolvedNumPr: new Map() };

  const styles = new Map<string, StyleInfo>();
  for (const raw of toArray(root['w:style'] as readonly unknown[] | undefined)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const info = parseStyleInfo(raw as Record<string, unknown>);
    if (info) styles.set(info.styleId, info);
  }

  const resolvedNumPr = new Map<string, StyleNumPr>();
  for (const styleId of styles.keys()) {
    const resolved = resolveNumPrChain(styleId, styles, 0);
    if (resolved) resolvedNumPr.set(styleId, resolved);
  }

  return { styles, resolvedNumPr };
}
