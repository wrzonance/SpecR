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

// Every resolved reference matching (kind, region) — real Word output emits at
// most one w:headerReference/w:footerReference per (variant, region) slot, but
// a non-conforming document could carry two (e.g. a merge artifact). Returns
// all matches, in document order, rather than just the first (#306 review): a
// single HeaderFooterRegion slot can only capture one of them, but the others
// must still be surfaced, never silently discarded.
function findResolvedRefs(
  resolved: readonly ResolvedHeaderFooterReference[],
  kind: VariantKind,
  region: RegionKind
): readonly ResolvedHeaderFooterReference[] {
  return resolved.filter((r) => r.reference.variant === kind && r.reference.region === region);
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

// A second (or later) reference resolving to the same (variant, region) slot as
// one already captured (#306 review) — real Word never emits this, but a
// non-conforming document could. HeaderFooterRegionSchema models exactly one
// region per slot, so only the first resolved reference is ever captured; every
// later one is preserved here under the same `unresolvedReference` kind
// missingPartEntry already uses for "resolved, but no content captured for it".
function duplicateReferenceEntry(
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
      reason:
        'duplicate header/footer reference for this variant/region — only the first ' +
        'resolved target is captured',
    }),
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

// One (variant, region) slot end-to-end: picks the first resolved reference to
// actually capture (there is only ever room for one HeaderFooterRegion per
// slot) and folds every additional resolved reference in as a duplicate
// unmodeled entry, never dropping it (#306 review).
function buildRegionSlot(
  kind: VariantKind,
  region: RegionKind,
  resolved: readonly ResolvedHeaderFooterReference[],
  active: boolean,
  entries: HeaderFooterCaptureEntries,
  known: KnownSectionIdentity
): RegionBuildResult {
  const [primaryRef, ...duplicateRefs] = findResolvedRefs(resolved, kind, region);
  const partXml = primaryRef ? partXmlFor(region, primaryRef.target, entries) : undefined;
  const built = buildVariant(kind, region, primaryRef, active, partXml, known);
  const duplicateUnmodeled = duplicateRefs.map((ref) => duplicateReferenceEntry(kind, region, ref));
  return { region: built.region, unmodeled: [...built.unmodeled, ...duplicateUnmodeled] };
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
  const header = buildRegionSlot(kind, 'header', resolved, active, entries, known);
  const footer = buildRegionSlot(kind, 'footer', resolved, active, entries, known);
  const built = compact({ header: header.region, footer: footer.region });
  return {
    variant: Object.keys(built).length > 0 ? built : undefined,
    unmodeled: [...header.unmodeled, ...footer.unmodeled],
  };
}

function unmodeledWarningLine(entry: HeaderFooterUnmodeledEntry): string {
  return `${entry.region} ${entry.variant} header/footer: ${entry.kind} content not modeled`;
}

// A page-number restart declared by the trailing w:sectPr (w:pgNumType/@w:start)
// cannot be promoted to composition.pageNumbering.startAt: PageNumberingSchema
// requires `mode` (continuous | restartPerSpec), and mode is a cross-document,
// package-level policy decision this single-document capture cannot infer
// (ADR-068) — fabricating one would misattribute a guess to the source
// document. The value is preserved verbatim, never silently dropped.
function pgNumStartWarningLine(pgNumStart: number): string {
  return (
    `document declares a page-number restart (w:pgNumType/@w:start=${pgNumStart}) — ` +
    'preserved as raw.pgNumStart; not applied to pageNumbering.startAt because ' +
    'pageNumbering.mode is a cross-document policy decision this capture cannot ' +
    'infer (ADR-068)'
  );
}

// Granular, one string per unmodeled item plus (ADR-068) one for a body that
// carries additional w:pPr/w:sectPr section breaks this capture's
// single-sectPr scope does not model its own header/footer set for, plus one
// for a preserved-but-unpromoted pgNumStart (see pgNumStartWarningLine above).
function buildRawWarnings(
  unmodeled: readonly HeaderFooterUnmodeledEntry[],
  hasAdditionalSectionBreaks: boolean,
  pgNumStart: number | undefined
): readonly string[] {
  const sectionBreakWarning = hasAdditionalSectionBreaks
    ? [
        'document contains additional section breaks with their own header/footer ' +
          'references, not modeled by this capture (ADR-068: single-sectPr scope)',
      ]
    : [];
  const pgNumStartWarning = pgNumStart !== undefined ? [pgNumStartWarningLine(pgNumStart)] : [];
  return [...unmodeled.map(unmodeledWarningLine), ...sectionBreakWarning, ...pgNumStartWarning];
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
// for malformed source XML); this call is deliberately NOT wrapped in a
// try/catch, so that ZodError propagates raw (pinned directly by
// header-footer.test.ts's buildComposition invariant test, #306).
//
// Exported (not just for internal reuse) so that invariant test can construct
// a candidate no real capture path can produce — `variants`' looseness is
// exactly what makes that possible without an `as unknown as` cast.
export function buildComposition(
  variants: Record<string, unknown>,
  unmodeled: readonly HeaderFooterUnmodeledEntry[],
  rawWarnings: readonly string[],
  pgNumStart: number | undefined
): HeaderFooterComposition | undefined {
  const raw = compact({
    warnings: rawWarnings.length > 0 ? rawWarnings : undefined,
    unmodeled: unmodeled.length > 0 ? unmodeled : undefined,
    pgNumStart,
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

  const rawWarnings = buildRawWarnings(
    unmodeled,
    sectionInfo.hasAdditionalSectionBreaks,
    sectionInfo.pgNumStart
  );
  return {
    composition: buildComposition(variants, unmodeled, rawWarnings, sectionInfo.pgNumStart),
    warnings: buildTreeWarnings(rawWarnings),
  };
}
