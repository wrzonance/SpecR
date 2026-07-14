// Header/footer capture orchestrator (#306, ADR-068): combines relationship
// resolution (header-footer-relationships.ts) with per-part content capture
// (header-footer-region.ts) into a single HeaderFooterComposition, validated
// once at the end via HeaderFooterCompositionSchema.parse() (mirrors
// resolveStyleCascade's existing .parse() boundary pattern). Every
// unmodeled/unresolved/inactive item is preserved in `raw.unmodeled` and
// reflected as one line in `raw.warnings`, with exactly one aggregate
// ParseWarning surfaced at the tree level iff `raw.warnings` is non-empty
// (mirrors the pre-existing table-content-skipped pattern in index.ts).

import { HeaderFooterCompositionSchema } from '../../ast/index.js';
import type { HeaderFooterComposition } from '../../ast/index.js';
import type { ParseWarning } from '../../ast/types.js';
import { compact } from './xml-utils.js';
import {
  parseDocumentRelationships,
  parseDocumentSettings,
  parseSectionHeaderFooterInfo,
  resolveReferenceTargets,
} from './header-footer-relationships.js';
import { captureRegion } from './header-footer-region.js';
import type { KnownSectionIdentity } from './header-footer-field-recognition.js';
// The PARSER-LOCAL HeaderFooterUnmodeledEntry (types.ts), not the ast-level
// one (detail: JsonValue) — captureRegion already returns this shape, and
// every detail value it builds is already compact()-ed (header-footer-region.ts),
// so it is JSON-safe by construction despite the `unknown` static type. The
// widening to the ast-level type happens implicitly at the final
// HeaderFooterCompositionSchema.parse() boundary in buildComposition below.
import type {
  HeaderFooterReference,
  HeaderFooterUnmodeledEntry,
  ResolvedHeaderFooterReference,
} from './types.js';

export interface HeaderFooterCaptureEntries {
  readonly documentXml: string;
  readonly settingsXml: string | null;
  readonly documentRelsXml: string | null;
  readonly headerParts: ReadonlyMap<string, string>;
  readonly footerParts: ReadonlyMap<string, string>;
}

export interface HeaderFooterCaptureResult {
  readonly composition: HeaderFooterComposition | undefined;
  readonly warnings: readonly ParseWarning[];
}

type VariantKind = HeaderFooterUnmodeledEntry['variant'];
type RegionKind = HeaderFooterUnmodeledEntry['region'];

interface ActivationInfo {
  readonly titlePg: boolean;
  readonly evenAndOddHeaders: boolean;
}

// `default` always applies (ADR-068); `first`/`even` apply only when the
// section's own toggle (w:titlePg / w:evenAndOddHeaders) is on.
function isVariantActive(kind: VariantKind, activation: ActivationInfo): boolean {
  if (kind === 'default') return true;
  return kind === 'first' ? activation.titlePg : activation.evenAndOddHeaders;
}

// 'bottom' for a header's rule line beneath its text, 'top' for a footer's
// rule line above it (header-footer-region.ts's captureRegion contract).
function ruleLineEdge(region: RegionKind): 'top' | 'bottom' {
  return region === 'header' ? 'bottom' : 'top';
}

function findResolvedRef(
  resolved: readonly ResolvedHeaderFooterReference[],
  kind: VariantKind,
  region: RegionKind
): ResolvedHeaderFooterReference | undefined {
  return resolved.find((r) => r.reference.variant === kind && r.reference.region === region);
}

function partXmlFor(
  region: RegionKind,
  target: string,
  entries: HeaderFooterCaptureEntries
): string | undefined {
  return (region === 'header' ? entries.headerParts : entries.footerParts).get(target);
}

function inactiveVariantEntry(
  kind: VariantKind,
  region: RegionKind,
  resolvedRef: ResolvedHeaderFooterReference
): HeaderFooterUnmodeledEntry {
  return {
    variant: kind,
    region,
    kind: 'inactiveVariant',
    detail: compact({ target: resolvedRef.target, rId: resolvedRef.reference.rId }),
  };
}

// A reference resolved to a real relationship target, but that target has no
// matching word/header*.xml or word/footer*.xml part among the ones read
// (e.g. a non-conforming part name) — distinct from unresolvedReference
// (rId with no relationship at all), but preserved under the same kind since
// neither case yields any capturable content.
function missingPartEntry(
  kind: VariantKind,
  region: RegionKind,
  resolvedRef: ResolvedHeaderFooterReference
): HeaderFooterUnmodeledEntry {
  return {
    variant: kind,
    region,
    kind: 'unresolvedReference',
    detail: compact({
      target: resolvedRef.target,
      rId: resolvedRef.reference.rId,
      reason: 'relationship target has no matching header/footer part',
    }),
  };
}

function unresolvedToUnmodeled(ref: HeaderFooterReference): HeaderFooterUnmodeledEntry {
  return {
    variant: ref.variant,
    region: ref.region,
    kind: 'unresolvedReference',
    detail: compact({ rId: ref.rId }),
  };
}

interface RegionBuildResult {
  readonly region: ReturnType<typeof captureRegion>['region'];
  readonly unmodeled: readonly HeaderFooterUnmodeledEntry[];
}

// Builds one (variant, region) slot — called up to 6 times (header/footer x
// default/first/even) from buildVariantForKind. Never throws for
// document-content reasons: only captureRegion's malformed-part-XML path
// throws (DOCX_HEADER_FOOTER_XML_INVALID), and that propagates unchanged.
function buildVariant(
  kind: VariantKind,
  region: RegionKind,
  resolvedRef: ResolvedHeaderFooterReference | undefined,
  active: boolean,
  partXml: string | undefined,
  known: KnownSectionIdentity
): RegionBuildResult {
  if (!resolvedRef) return { region: undefined, unmodeled: [] };
  if (!active)
    return { region: undefined, unmodeled: [inactiveVariantEntry(kind, region, resolvedRef)] };
  if (partXml === undefined) {
    return { region: undefined, unmodeled: [missingPartEntry(kind, region, resolvedRef)] };
  }
  const captured = captureRegion(partXml, ruleLineEdge(region), kind, region, known);
  return { region: captured.region, unmodeled: captured.unmodeled };
}

interface KindBuildResult {
  readonly variant: Record<string, unknown> | undefined;
  readonly unmodeled: readonly HeaderFooterUnmodeledEntry[];
}

function buildVariantForKind(
  kind: VariantKind,
  resolved: readonly ResolvedHeaderFooterReference[],
  activation: ActivationInfo,
  entries: HeaderFooterCaptureEntries,
  known: KnownSectionIdentity
): KindBuildResult {
  const active = isVariantActive(kind, activation);
  const headerRef = findResolvedRef(resolved, kind, 'header');
  const header = buildVariant(
    kind,
    'header',
    headerRef,
    active,
    headerRef ? partXmlFor('header', headerRef.target, entries) : undefined,
    known
  );
  const footerRef = findResolvedRef(resolved, kind, 'footer');
  const footer = buildVariant(
    kind,
    'footer',
    footerRef,
    active,
    footerRef ? partXmlFor('footer', footerRef.target, entries) : undefined,
    known
  );
  const built = compact({ header: header.region, footer: footer.region });
  return {
    variant: Object.keys(built).length > 0 ? built : undefined,
    unmodeled: [...header.unmodeled, ...footer.unmodeled],
  };
}

function unmodeledWarningLine(entry: HeaderFooterUnmodeledEntry): string {
  return `${entry.region} ${entry.variant} header/footer: ${entry.kind} content not modeled`;
}

// Granular, one string per unmodeled item plus (ADR-068) one for a body that
// carries additional w:pPr/w:sectPr section breaks this capture's
// single-sectPr scope does not model its own header/footer set for.
function buildRawWarnings(
  unmodeled: readonly HeaderFooterUnmodeledEntry[],
  hasAdditionalSectionBreaks: boolean
): readonly string[] {
  const sectionBreakWarning = hasAdditionalSectionBreaks
    ? [
        'document contains additional section breaks with their own header/footer ' +
          'references, not modeled by this capture (ADR-068: single-sectPr scope)',
      ]
    : [];
  return [...unmodeled.map(unmodeledWarningLine), ...sectionBreakWarning];
}

// Exactly one aggregate ParseWarning at the tree level iff rawWarnings is
// non-empty (mirrors the pre-existing table-content-skipped pattern).
function buildTreeWarnings(rawWarnings: readonly string[]): readonly ParseWarning[] {
  if (rawWarnings.length === 0) return [];
  return [
    {
      type: 'header-footer-content-skipped',
      suggestion: `${rawWarnings.length} header/footer item(s) captured but not fully modeled — see raw.warnings/raw.unmodeled`,
    },
  ];
}

// Built as a loosely-typed intermediate (Record<string, unknown>, never
// pre-typed as HeaderFooterComposition) and validated exactly once via
// .parse() below (ADR-068). Every unmodeled detail was already passed
// through compact() at construction (header-footer-region.ts, this module),
// so this parse is expected to always succeed on any real document input —
// if it ever throws, that is an uncaught internal defect in the capture
// code, never remapped to DOCX_HEADER_FOOTER_XML_INVALID (reserved strictly
// for malformed source XML).
function buildComposition(
  variants: Record<string, unknown>,
  unmodeled: readonly HeaderFooterUnmodeledEntry[],
  rawWarnings: readonly string[]
): HeaderFooterComposition | undefined {
  const raw = compact({
    warnings: rawWarnings.length > 0 ? rawWarnings : undefined,
    unmodeled: unmodeled.length > 0 ? unmodeled : undefined,
  });
  const candidate: Record<string, unknown> = compact({
    variants: Object.keys(variants).length > 0 ? variants : undefined,
    raw: Object.keys(raw).length > 0 ? raw : undefined,
  });
  return Object.keys(candidate).length > 0
    ? HeaderFooterCompositionSchema.parse(candidate)
    : undefined;
}

/**
 * Capture a document's header/footer content into a HeaderFooterComposition
 * (#306, ADR-068): resolves the trailing body-level w:sectPr's
 * default/first/even header/footer references against
 * word/document.xml.rels, captures each active variant's part content, and
 * preserves every unsupported or inactive item in `raw` rather than dropping
 * it. Absent `composition` === no header/footer content was captured for
 * this document. `known` (section/title) comes from parseCoreMetadata,
 * never the content-inference fallback (ADR-068: core.xml-literal only).
 */
export function captureHeaderFooter(
  entries: HeaderFooterCaptureEntries,
  known: KnownSectionIdentity
): HeaderFooterCaptureResult {
  const relationships = parseDocumentRelationships(entries.documentRelsXml);
  const sectionInfo = parseSectionHeaderFooterInfo(entries.documentXml);
  const settings = parseDocumentSettings(entries.settingsXml);
  const { resolved, unresolved } = resolveReferenceTargets(sectionInfo.references, relationships);
  const activation: ActivationInfo = {
    titlePg: sectionInfo.titlePg,
    evenAndOddHeaders: settings.evenAndOddHeaders,
  };

  const defaultResult = buildVariantForKind('default', resolved, activation, entries, known);
  const firstResult = buildVariantForKind('first', resolved, activation, entries, known);
  const evenResult = buildVariantForKind('even', resolved, activation, entries, known);

  const variants = compact({
    default: defaultResult.variant,
    first: firstResult.variant,
    even: evenResult.variant,
  });
  const unmodeled = [
    ...defaultResult.unmodeled,
    ...firstResult.unmodeled,
    ...evenResult.unmodeled,
    ...unresolved.map(unresolvedToUnmodeled),
  ];

  const rawWarnings = buildRawWarnings(unmodeled, sectionInfo.hasAdditionalSectionBreaks);
  return {
    composition: buildComposition(variants, unmodeled, rawWarnings),
    warnings: buildTreeWarnings(rawWarnings),
  };
}
