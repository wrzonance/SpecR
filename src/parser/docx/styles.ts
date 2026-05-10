import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { getAttrVal, getAttrNumVal, extractAttrStr, toArray } from './xml-utils.js';
import type { StyleInfo, StyleMap, StyleNumPr } from './types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'w:style',
});

const MAX_BASED_ON_DEPTH = 20; // cycle guard

function parseNumPr(pPr: Record<string, unknown>): StyleNumPr | undefined {
  const numPr = pPr['w:numPr'] as Record<string, unknown> | undefined;
  if (!numPr) return undefined;
  const numId = getAttrNumVal(numPr['w:numId']);
  if (numId === 0) return undefined; // numId=0 suppresses numbering
  const ilvl = getAttrNumVal(numPr['w:ilvl']);
  return { numId, ilvl };
}

function parseVanish(raw: Record<string, unknown>): boolean {
  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const pRpr = pPr?.['w:rPr'] as Record<string, unknown> | undefined;
  const rPr = raw['w:rPr'] as Record<string, unknown> | undefined;
  return 'w:vanish' in (pRpr ?? {}) || 'w:vanish' in (rPr ?? {});
}

function parseOutlineLvl(pPr: Record<string, unknown> | undefined): number | undefined {
  if (!pPr) return undefined;
  const raw = pPr['w:outlineLvl'];
  if (raw === undefined) return undefined;
  const n = getAttrNumVal(raw);
  return isNaN(n) ? undefined : n;
}

function resolvedName(raw: Record<string, unknown>, fallback: string): string {
  return getAttrVal(raw['w:name']) || fallback;
}

function parseStyleInfo(raw: Record<string, unknown>): StyleInfo | null {
  const styleType = extractAttrStr(raw, '@_w:type') || 'paragraph';
  if (styleType !== 'paragraph') return null;
  const styleId = extractAttrStr(raw, '@_w:styleId');
  if (!styleId) return null;

  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  const basedOn = getAttrVal(raw['w:basedOn']);
  const next = getAttrVal(raw['w:next']);
  const numPr = pPr ? parseNumPr(pPr) : undefined;
  const outlineLvl = parseOutlineLvl(pPr);

  return {
    styleId,
    name: resolvedName(raw, styleId),
    ...(basedOn ? { basedOn } : {}),
    ...(next ? { next } : {}),
    ...(numPr ? { numPr } : {}),
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
