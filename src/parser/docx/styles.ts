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
import { getAttrVal, getAttrNumVal, extractAttrStr, toArray, asRecord } from './xml-utils.js';
import {
  defaultParagraphStyleId,
  defaultRunEmphasis,
  parseRunEmphasis,
  characterRunEmphasisChainMap,
  resolvedRunEmphasisMap,
} from './emphasis-styles.js';
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

function parseVanish(raw: Record<string, unknown>): boolean {
  const pPr = asRecord(raw['w:pPr']);
  const pRpr = asRecord(pPr?.['w:rPr']);
  const rPr = asRecord(raw['w:rPr']);
  return (pRpr !== undefined && 'w:vanish' in pRpr) || (rPr !== undefined && 'w:vanish' in rPr);
}

// CT_OnOff, presence-aware: undefined when the style's pPr has no
// w:pageBreakBefore at all; an explicit falsey w:val (false/0/off) is a stored
// FALSE that must override an ancestor's true in resolvePageBreakChain (ADR-075).
function parsePageBreakBefore(pPr: Record<string, unknown> | undefined): boolean | undefined {
  if (!pPr || !('w:pageBreakBefore' in pPr)) return undefined;
  const val = getAttrVal(pPr['w:pageBreakBefore']);
  return val !== 'false' && val !== '0' && val !== 'off';
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

// The optional StyleInfo fields (everything but styleId/name), assembled with
// exactOptionalPropertyTypes-friendly conditional spreads. Split out of parseStyleInfo
// to keep each function's cognitive complexity within budget.
function optionalStyleFields(
  raw: Record<string, unknown>,
  pPr: Record<string, unknown> | undefined
): Partial<StyleInfo> {
  const basedOn = getAttrVal(raw['w:basedOn']);
  const next = getAttrVal(raw['w:next']);
  const numPrResult = pPr ? parseNumPr(pPr) : ({ kind: 'absent' } as const);
  const outlineLvl = parseOutlineLvl(pPr);
  const jc = pPr ? getAttrVal(pPr['w:jc']) : '';
  const pageBreakBefore = parsePageBreakBefore(pPr);
  const runEmphasis = parseRunEmphasis(asRecord(raw['w:rPr']));
  return {
    ...(basedOn ? { basedOn } : {}),
    ...(next ? { next } : {}),
    ...numPrFields(numPrResult),
    ...(parseVanish(raw) ? { isVanish: true as const } : {}),
    ...(outlineLvl !== undefined ? { outlineLvl } : {}),
    ...(jc ? { jc } : {}),
    ...(pageBreakBefore !== undefined ? { pageBreakBefore } : {}),
    ...(runEmphasis ? { runEmphasis } : {}),
  };
}

function parseStyleInfo(raw: Record<string, unknown>): StyleInfo | null {
  const styleType = extractAttrStr(raw, '@_w:type') || 'paragraph';
  if (styleType !== 'paragraph') return null;
  const styleId = extractAttrStr(raw, '@_w:styleId');
  if (!styleId) return null;

  const pPr = raw['w:pPr'] as Record<string, unknown> | undefined;
  return {
    styleId,
    name: resolvedName(raw, styleId),
    ...optionalStyleFields(raw, pPr),
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

// Effective alignment for a style: its own w:jc, else the nearest basedOn ancestor's.
// Mirrors resolveNumPrChain; no suppress sentinel exists for alignment.
function resolveJcChain(
  styleId: string,
  styles: ReadonlyMap<string, StyleInfo>,
  depth: number
): string | undefined {
  if (depth > MAX_BASED_ON_DEPTH) return undefined;
  const style = styles.get(styleId);
  if (!style) return undefined;
  if (style.jc) return style.jc;
  return style.basedOn ? resolveJcChain(style.basedOn, styles, depth + 1) : undefined;
}

function resolveVanishChain(
  styleId: string,
  styles: ReadonlyMap<string, StyleInfo>,
  depth: number
): boolean {
  if (depth > MAX_BASED_ON_DEPTH) return false;
  const style = styles.get(styleId);
  if (!style) return false;
  if (style.isVanish) return true;
  return style.basedOn ? resolveVanishChain(style.basedOn, styles, depth + 1) : false;
}

// Effective w:pageBreakBefore for a style: its own explicit CT_OnOff value wins
// (a child style's w:val="false" disables an ancestor's break), else the nearest
// basedOn ancestor's. Nearest-specified-wins like resolveJcChain — NOT the
// any-ancestor-true walk of resolveVanishChain, because pageBreakBefore stores
// explicit falses (ADR-075).
function resolvePageBreakChain(
  styleId: string,
  styles: ReadonlyMap<string, StyleInfo>,
  depth: number
): boolean | undefined {
  if (depth > MAX_BASED_ON_DEPTH) return undefined;
  const style = styles.get(styleId);
  if (!style) return undefined;
  if (style.pageBreakBefore !== undefined) return style.pageBreakBefore;
  return style.basedOn ? resolvePageBreakChain(style.basedOn, styles, depth + 1) : undefined;
}

interface CharStyleInfo {
  readonly basedOn?: string;
  readonly isVanish: boolean;
}

function parseCharacterStyles(root: Record<string, unknown>): Map<string, CharStyleInfo> {
  const styles = new Map<string, CharStyleInfo>();
  for (const raw of toArray(root['w:style'] as readonly unknown[] | undefined)) {
    const rec = asRecord(raw);
    if (!rec || extractAttrStr(rec, '@_w:type') !== 'character') continue;
    const styleId = extractAttrStr(rec, '@_w:styleId');
    if (!styleId) continue;
    const rPr = asRecord(rec['w:rPr']);
    const basedOn = getAttrVal(rec['w:basedOn']);
    styles.set(styleId, {
      ...(basedOn ? { basedOn } : {}),
      isVanish: rPr !== undefined && 'w:vanish' in rPr,
    });
  }
  return styles;
}

function resolveCharVanishChain(
  styleId: string,
  styles: ReadonlyMap<string, CharStyleInfo>,
  depth: number
): boolean {
  if (depth > MAX_BASED_ON_DEPTH) return false;
  const style = styles.get(styleId);
  if (!style) return false;
  if (style.isVanish) return true;
  return style.basedOn ? resolveCharVanishChain(style.basedOn, styles, depth + 1) : false;
}

// Character-style vanish must follow basedOn chains just like paragraph styles
// (CodeRabbit #295): a run styled ChildHide→basedOn→BaseHide is hidden even
// though only BaseHide carries w:vanish directly.
function characterStyleVanishIds(root: Record<string, unknown>): Set<string> {
  const styles = parseCharacterStyles(root);
  const ids = new Set<string>();
  for (const styleId of styles.keys()) {
    if (resolveCharVanishChain(styleId, styles, 0)) ids.add(styleId);
  }
  return ids;
}

function emptyStyleMap(): StyleMap {
  return {
    styles: new Map(),
    resolvedNumPr: new Map(),
    resolvedJc: new Map(),
    vanishStyleIds: new Set(),
    vanishCharStyleIds: new Set(),
    pageBreakStyleIds: new Set(),
    defaultRunEmphasis: {},
    resolvedRunEmphasis: new Map(),
    characterRunEmphasisChains: new Map(),
  };
}

function paragraphStyles(root: Record<string, unknown>): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  for (const raw of toArray(root['w:style'] as readonly unknown[] | undefined)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const info = parseStyleInfo(raw as Record<string, unknown>);
    if (info) styles.set(info.styleId, info);
  }
  return styles;
}

function resolvedNumPrMap(styles: ReadonlyMap<string, StyleInfo>): Map<string, StyleNumPr> {
  const resolvedNumPr = new Map<string, StyleNumPr>();
  for (const styleId of styles.keys()) {
    const resolved = resolveNumPrChain(styleId, styles, 0);
    if (resolved) resolvedNumPr.set(styleId, resolved);
  }
  return resolvedNumPr;
}

function resolvedJcMap(styles: ReadonlyMap<string, StyleInfo>): Map<string, string> {
  const resolvedJc = new Map<string, string>();
  for (const styleId of styles.keys()) {
    const resolved = resolveJcChain(styleId, styles, 0);
    if (resolved) resolvedJc.set(styleId, resolved);
  }
  return resolvedJc;
}

function pageBreakStyleIdSet(styles: ReadonlyMap<string, StyleInfo>): Set<string> {
  const ids = new Set<string>();
  for (const styleId of styles.keys()) {
    if (resolvePageBreakChain(styleId, styles, 0) === true) ids.add(styleId);
  }
  return ids;
}

function vanishStyleIdSet(styles: ReadonlyMap<string, StyleInfo>): Set<string> {
  const vanishStyleIds = new Set<string>();
  for (const styleId of styles.keys()) {
    if (resolveVanishChain(styleId, styles, 0)) vanishStyleIds.add(styleId);
  }
  return vanishStyleIds;
}

export function buildStyleMap(xml: string): StyleMap {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse styles.xml', { code: 'STYLES_XML_INVALID', cause: err });
  }

  const root = (parsed as Record<string, unknown>)['w:styles'] as
    Record<string, unknown> | undefined;
  if (!root) return emptyStyleMap();

  const styles = paragraphStyles(root);
  const emphasisDefaults = defaultRunEmphasis(root);
  const defaultStyleId = defaultParagraphStyleId(root);
  return {
    styles,
    ...(defaultStyleId ? { defaultParagraphStyleId: defaultStyleId } : {}),
    resolvedNumPr: resolvedNumPrMap(styles),
    resolvedJc: resolvedJcMap(styles),
    vanishStyleIds: vanishStyleIdSet(styles),
    vanishCharStyleIds: characterStyleVanishIds(root),
    pageBreakStyleIds: pageBreakStyleIdSet(styles),
    defaultRunEmphasis: emphasisDefaults,
    resolvedRunEmphasis: resolvedRunEmphasisMap(styles, emphasisDefaults),
    characterRunEmphasisChains: characterRunEmphasisChainMap(root),
  };
}
