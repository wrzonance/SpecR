// Header/footer relationship + section-property capture (#306, ADR-068):
// word/document.xml.rels (relationship map), the trailing body-level
// w:sectPr (header/footer references, titlePg, pgNumStart), and
// word/settings.xml (evenAndOddHeaders). Scoped strictly to discovery +
// resolution — content capture itself lives in header-footer-region.ts and
// header-footer.ts.

import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import {
  asRecord,
  createDocumentXmlParser,
  extractAttrStr,
  getAttrVal,
  toArray,
} from './xml-utils.js';
import type { PageSize } from '../../ast/types.js';
import type {
  DocumentSettingsInfo,
  HeaderFooterReference,
  RelationshipMap,
  ResolvedHeaderFooterReference,
  SectionHeaderFooterInfo,
} from './types.js';

// OOXML CT_OnOff toggle (ECMA-376 §17.17.4), used below by both w:titlePg
// (trailing w:sectPr) and w:evenAndOddHeaders (settings.xml): an absent
// element is off; a present element with no @w:val, or @w:val outside
// {0,false,off}, is on; an explicit @w:val in {0,false,off} is off. Mirrors
// this codebase's established CT_OnOff convention (resolver.ts's toggle(),
// comments.ts's isStrikeOn()) — presence alone is not enough, since a
// document can carry an explicit off-toggle (<w:titlePg w:val="0"/>).
function isOnOffActive(el: unknown): boolean {
  if (el === undefined) return false;
  const val = getAttrVal(el);
  return val !== '0' && val !== 'false' && val !== 'off';
}

// ─── word/_rels/document.xml.rels ──────────────────────────────────────────

// The OPC relationships namespace has no element/attribute prefix at all
// (unlike word/document.xml's w: elements), so 'Relationship'/'Id'/'Target'
// are literal, unprefixed tag/attribute names.
const relsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => name === 'Relationship',
});

// Rels Target values are relative to the containing part's directory
// (word/_rels/document.xml.rels's part is word/document.xml, so its
// directory is word/), e.g. "header1.xml" -> "word/header1.xml". The rare
// package-absolute form ("/word/header1.xml") is normalized by stripping the
// leading slash instead of double-prefixing.
function normalizeRelationshipTarget(rawTarget: string): string {
  return rawTarget.startsWith('/') ? rawTarget.slice(1) : `word/${rawTarget}`;
}

function parseRelsXml(relsXml: string, partLabel: string): Record<string, unknown> {
  try {
    return relsParser.parse(relsXml) as Record<string, unknown>;
  } catch (err) {
    throw new ParserError(`failed to parse relationships for ${partLabel}`, {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause: err,
    });
  }
}

function readRelationshipEntries(
  relsXml: string,
  partLabel: string
): readonly Record<string, unknown>[] {
  const parsed = parseRelsXml(relsXml, partLabel);
  const root = asRecord(parsed['Relationships']);
  return toArray<Record<string, unknown>>(
    root?.['Relationship'] as readonly Record<string, unknown>[] | undefined
  );
}

/** Absent (`null`) or blank rels XML yields an empty map, not a throw. */
export function parseDocumentRelationships(relsXml: string | null): RelationshipMap {
  if (relsXml === null || relsXml.trim() === '') return new Map();
  const rawRelationships = readRelationshipEntries(relsXml, 'word/_rels/document.xml.rels');
  const map = new Map<string, string>();
  for (const rel of rawRelationships) {
    const id = extractAttrStr(rel, '@_Id');
    const target = extractAttrStr(rel, '@_Target');
    if (id && target) map.set(id, normalizeRelationshipTarget(target));
  }
  return map;
}

// ECMA-376 Part 1, §15.2.13 (Annex A): the fixed relationship Type URI that
// identifies an image relationship, shared by every OPC part's .rels file —
// not header/footer-specific, just narrower than the unfiltered
// parseDocumentRelationships contract above.
const IMAGE_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/**
 * Parse a header/footer PART's own `.rels` file (e.g.
 * `word/_rels/header1.xml.rels`), filtered to image relationships only.
 * `partLabel` names the owning part in any thrown ParserError message, e.g.
 * `"word/header1.xml"`. Absent (`null`) or blank rels XML yields an empty
 * map, not a throw — mirrors parseDocumentRelationships.
 */
export function parseImageRelationships(
  relsXml: string | null,
  partLabel: string
): RelationshipMap {
  if (relsXml === null || relsXml.trim() === '') return new Map();
  const rawRelationships = readRelationshipEntries(relsXml, partLabel);
  const map = new Map<string, string>();
  for (const rel of rawRelationships) {
    const type = extractAttrStr(rel, '@_Type');
    if (type !== IMAGE_RELATIONSHIP_TYPE) continue;
    const id = extractAttrStr(rel, '@_Id');
    const target = extractAttrStr(rel, '@_Target');
    if (id && target) map.set(id, normalizeRelationshipTarget(target));
  }
  return map;
}

// ─── word/document.xml — trailing body-level w:sectPr ──────────────────────

// Own instance (isArray tags scoped to this scan), matching the established
// per-scanner pattern (document.ts, tables.ts): shares createDocumentXmlParser's
// #22/#120-safe base config while tuning isArray to this scan's own tags.
const sectPrParser = createDocumentXmlParser(['w:p', 'w:headerReference', 'w:footerReference']);

const KNOWN_VARIANTS = new Set<HeaderFooterReference['variant']>(['default', 'first', 'even']);

function isKnownVariant(value: string): value is HeaderFooterReference['variant'] {
  return KNOWN_VARIANTS.has(value as HeaderFooterReference['variant']);
}

// Real Word output only ever emits w:type="default|first|even" (ST_HdrFtr).
// A reference with an unrecognized type is dropped, never fabricated into a
// guessed variant — there is no decidable mapping for it.
function parseReferenceList(
  rawList: readonly Record<string, unknown>[],
  region: HeaderFooterReference['region']
): readonly HeaderFooterReference[] {
  const out: HeaderFooterReference[] = [];
  for (const raw of rawList) {
    const variant = extractAttrStr(raw, '@_w:type');
    const rId = extractAttrStr(raw, '@_r:id');
    if (isKnownVariant(variant) && rId) out.push({ variant, region, rId });
  }
  return out;
}

// Decomposed out of parseSectionHeaderFooterInfo per ADR-068/spike finding
// #11 — the undecomposed version hit eslint's complexity 10 cap.
function readSectPrReferences(sectPr: Record<string, unknown>): readonly HeaderFooterReference[] {
  const headers = parseReferenceList(
    toArray<Record<string, unknown>>(
      sectPr['w:headerReference'] as readonly Record<string, unknown>[] | undefined
    ),
    'header'
  );
  const footers = parseReferenceList(
    toArray<Record<string, unknown>>(
      sectPr['w:footerReference'] as readonly Record<string, unknown>[] | undefined
    ),
    'footer'
  );
  return [...headers, ...footers];
}

function extractPgNumStart(sectPr: Record<string, unknown>): number | undefined {
  const pgNumType = asRecord(sectPr['w:pgNumType']);
  if (!pgNumType) return undefined;
  const startStr = extractAttrStr(pgNumType, '@_w:start');
  if (!startStr) return undefined;
  const n = parseInt(startStr, 10);
  return isNaN(n) ? undefined : n;
}

// Shared by width and height (w:pgSz/@w:w, @w:h): stricter than
// extractPgNumStart's isNaN-only guard above — a zero/negative page
// dimension is unrenderable, not merely odd, so this also rejects <= 0.
// Pure, total, no throw.
function parsePositiveDimension(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Mirrors isKnownVariant's drop-unrecognized-value precedent above: kept
// only when w:pgSz/@w:orient is exactly one of the two known values,
// otherwise undefined — never fabricated.
function extractOrientation(sectPr: Record<string, unknown>): 'portrait' | 'landscape' | undefined {
  const pgSz = asRecord(sectPr['w:pgSz']);
  if (!pgSz) return undefined;
  const orient = extractAttrStr(pgSz, '@_w:orient');
  return orient === 'portrait' || orient === 'landscape' ? orient : undefined;
}

// ADR-075 §3: width/height/orientation as one all-or-nothing unit — never a
// partial { width: NaN } shape. Reads only the trailing body-level w:sectPr's
// own w:pgSz (ADR-068 single-sectPr scope, extended here to page size: a
// mid-body w:pPr/w:sectPr section break declaring a different page size is a
// KNOWN AMBIGUITY this parser does not model, surfaced only indirectly via
// hasAdditionalSectionBreaks).
function extractPageSize(sectPr: Record<string, unknown>): PageSize | undefined {
  const pgSz = asRecord(sectPr['w:pgSz']);
  if (!pgSz) return undefined;
  const width = parsePositiveDimension(pgSz['@_w:w']);
  const height = parsePositiveDimension(pgSz['@_w:h']);
  if (width === undefined || height === undefined) return undefined;
  const orientation = extractOrientation(sectPr);
  return { width, height, ...(orientation !== undefined ? { orientation } : {}) };
}

// True when the body carries any w:pPr/w:sectPr beyond the single trailing
// body-level w:sectPr this parser reads (ADR-068: single-sectPr scope) — a
// second section this slice does not model its own header/footer set for.
function bodyHasAdditionalSectionBreaks(body: Record<string, unknown>): boolean {
  return toArray<Record<string, unknown>>(
    body['w:p'] as readonly Record<string, unknown>[] | undefined
  ).some((p) => {
    const pPr = asRecord(p['w:pPr']);
    return pPr !== undefined && 'w:sectPr' in pPr;
  });
}

function parseSectPrXml(documentXml: string): Record<string, unknown> {
  try {
    return sectPrParser.parse(documentXml) as Record<string, unknown>;
  } catch (err) {
    throw new ParserError('failed to scan section properties in word/document.xml', {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause: err,
    });
  }
}

/**
 * Read the single trailing body-level w:sectPr's header/footer references,
 * titlePg toggle, and pgNumType/@start (ADR-068: single-sectPr scope). By the
 * time this runs, document.xml has already been successfully parsed once by
 * document.ts's parseDocument (DOCX_MISSING_DOCUMENT) earlier in the
 * pipeline — this re-parse is defensive, wrapped the same way as the other
 * two functions in this module so no raw XML-parser error ever escapes
 * un-contextualized.
 */
export function parseSectionHeaderFooterInfo(documentXml: string): SectionHeaderFooterInfo {
  const parsed = parseSectPrXml(documentXml);
  const doc = asRecord(parsed['w:document']);
  const body = doc ? asRecord(doc['w:body']) : undefined;
  if (!body) return { references: [], titlePg: false, hasAdditionalSectionBreaks: false };

  const hasAdditionalSectionBreaks = bodyHasAdditionalSectionBreaks(body);
  const sectPr = asRecord(body['w:sectPr']);
  if (!sectPr) return { references: [], titlePg: false, hasAdditionalSectionBreaks };

  const pgNumStart = extractPgNumStart(sectPr);
  const pageSize = extractPageSize(sectPr);
  return {
    references: readSectPrReferences(sectPr),
    titlePg: isOnOffActive(sectPr['w:titlePg']),
    ...(pgNumStart !== undefined ? { pgNumStart } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
    hasAdditionalSectionBreaks,
  };
}

// ─── word/settings.xml ──────────────────────────────────────────────────────

const settingsParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
});

function parseSettingsXml(settingsXml: string): Record<string, unknown> {
  try {
    return settingsParser.parse(settingsXml) as Record<string, unknown>;
  } catch (err) {
    throw new ParserError('failed to parse word/settings.xml', {
      code: 'DOCX_HEADER_FOOTER_XML_INVALID',
      cause: err,
    });
  }
}

/** Absent (`null`) or blank settings XML yields `evenAndOddHeaders: false`. */
export function parseDocumentSettings(settingsXml: string | null): DocumentSettingsInfo {
  if (settingsXml === null || settingsXml.trim() === '') return { evenAndOddHeaders: false };
  const parsed = parseSettingsXml(settingsXml);
  const root = asRecord(parsed['w:settings']);
  return { evenAndOddHeaders: root !== undefined && isOnOffActive(root['w:evenAndOddHeaders']) };
}

// ─── reference resolution ───────────────────────────────────────────────────

/**
 * Resolve each reference's r:id against the relationship map. Returns a list
 * of (reference, target) pairs rather than a Map keyed by target path: two
 * distinct reference slots (e.g. default and even header) can legitimately
 * resolve to the same physical part, and a path-keyed map would silently
 * collapse them into one entry (ADR-068).
 */
export function resolveReferenceTargets(
  references: readonly HeaderFooterReference[],
  relationships: RelationshipMap
): {
  readonly resolved: readonly ResolvedHeaderFooterReference[];
  readonly unresolved: readonly HeaderFooterReference[];
} {
  const resolved: ResolvedHeaderFooterReference[] = [];
  const unresolved: HeaderFooterReference[] = [];
  for (const reference of references) {
    const target = relationships.get(reference.rId);
    if (target !== undefined) {
      resolved.push({ reference, target });
    } else {
      unresolved.push(reference);
    }
  }
  return { resolved, unresolved };
}
