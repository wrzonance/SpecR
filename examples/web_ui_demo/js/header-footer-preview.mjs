// Pure header/footer preview-model builder for the demo editor (#477).
//
// The markdown renderer intentionally has no page chrome (running headers/
// footers are a page-layout concept, not a content-tree one — see #477's
// "Preview" scope note), so the demo renders its own HTML approximation from
// the resolved composition. Every export here is pure: no DOM, no fetch, and
// never mutates an argument (house rule).
//
// Delegates ALL v1/v2 variant precedence to header-footer-fields.mjs's
// selectVariant — this file must never re-derive the `variants.default`-
// wins-over-legacy-top-level KNOWN AMBIGUITY itself (a spike draft did this
// by accident; see the design's spike-learnings note). Keeping that one rule
// in one place is what keeps the editor and the preview from silently
// disagreeing about which variant is showing.
import { selectVariant, FIELD_KINDS } from './header-footer-fields.mjs';

// Kinds whose true value only exists at DOCX-generation time — a live
// SpecTree's section number/title, or a Word PAGE field code that Word
// itself paginates. resolveFieldDisplay NEVER reads `field.text` for these,
// regardless of what a malformed/legacy payload happens to carry on the
// field — mirrors src/generator/header-footer-fields.ts's
// resolveSectionNumber/resolveSectionTitle/resolvePageNumber, none of which
// read `field.text` either. The placeholder is fixed per kind, not derived
// from the field, so the preview can never be tricked into fabricating a
// generation-time value.
const GENERATION_ONLY_PLACEHOLDERS = new Map([
  ['sectionNumber', '[Section number — from the live spec]'],
  ['sectionTitle', '[Section title — from the live spec]'],
  ['pageNumber', '[Page # — Word field]'],
]);

// Identity-value kinds the demo preview CAN show a real value for: `date` is
// computed client-side, and `projectName`/`clientName` are already loaded in
// the demo's own project/client state. Every other identity kind
// (packageName/revisionName/revisionLabel/projectNumber/clientNumber) is
// deliberately excluded from PreviewFieldContext — the demo has no verified
// source for them (src/db/queries/header-footer-context.ts's
// buildHeaderFooterFromProject resolves only projectName/clientName for a
// bare specId too), and guessing a value would be fabrication, not preview.
// Enforced here regardless of what a caller's context object happens to
// carry, so an accidental extra key can never leak into the preview.
const PREVIEWABLE_IDENTITY_KEYS = new Set(['date', 'projectName', 'clientName']);

const FIELD_LABELS = new Map(FIELD_KINDS.map((f) => [f.value, f.label]));

function unavailable(kind) {
  const label = FIELD_LABELS.get(kind) ?? kind ?? 'field';
  return { status: 'unavailable', text: `[${label} — not set]` };
}

function resolveLiteralDisplay(field) {
  return field.text ? { status: 'resolved', text: field.text } : unavailable('literal');
}

function resolveIdentityDisplay(kind, previewContext) {
  if (!PREVIEWABLE_IDENTITY_KEYS.has(kind)) return unavailable(kind);
  const value = previewContext?.[kind];
  return value ? { status: 'resolved', text: value } : unavailable(kind);
}

/**
 * The display text + status for one field, for the demo's own preview — NOT
 * DOCX generation (see src/generator/header-footer-fields.ts's
 * resolveFieldChildren for that). Total: never throws, even on a null/
 * undefined/malformed field. `previewContext` is a `PreviewFieldContext`
 * (`{ date?, projectName?, clientName? }`, all optional) and defaults to
 * `{}` — an absent field, an absent context, and an absent value at any key
 * all resolve the same way: `status: 'unavailable'` with a non-empty,
 * human-readable placeholder (never `''`, which would be indistinguishable
 * from a real empty field on screen).
 */
export function resolveFieldDisplay(field, previewContext = {}) {
  if (field == null) return unavailable(undefined);
  if (GENERATION_ONLY_PLACEHOLDERS.has(field.kind)) {
    return { status: 'generation-only', text: GENERATION_ONLY_PLACEHOLDERS.get(field.kind) };
  }
  if (field.kind === 'literal') return resolveLiteralDisplay(field);
  return resolveIdentityDisplay(field.kind, previewContext);
}

// A resolved cell: its separator (defaulted the same way as the generator's
// renderCellRuns, ' ') plus one FieldResolution per content field, in order.
function resolveCell(cell, previewContext) {
  const content = Array.isArray(cell?.content) ? cell.content : [];
  return {
    separator: cell?.separator ?? ' ',
    fields: content.map((field) => resolveFieldDisplay(field, previewContext)),
  };
}

// A resolved region (header or footer): left/center/right cells plus the
// rule-line config passed through unchanged — a page-chrome detail the
// preview view renders, not a value this module derives.
function resolveRegion(region, previewContext) {
  return {
    left: resolveCell(region?.left, previewContext),
    center: resolveCell(region?.center, previewContext),
    right: resolveCell(region?.right, previewContext),
    ruleLine: region?.ruleLine ?? null,
  };
}

/**
 * The full preview model for one page variant of `composition` — header and
 * footer regions resolved via {@link resolveFieldDisplay}, the page-
 * numbering policy passed through unchanged, and a warnings summary. Total:
 * tolerates a null/undefined/empty composition, variant, region, or cell at
 * every level without throwing — absence renders as an empty region, never
 * an error.
 *
 * `variantKey` defaults to `'default'` and is handed straight to
 * `selectVariant` (see the module doc comment) — `'first'`/`'even'` read
 * only `composition.variants[variantKey]` with no fallback to `'default'`
 * when unconfigured, matching Word's own inherit-the-default behavior.
 */
export function buildPreviewModel(composition, variantKey = 'default', previewContext = {}) {
  const variant = selectVariant(composition, variantKey);
  return {
    header: resolveRegion(variant?.header, previewContext),
    footer: resolveRegion(variant?.footer, previewContext),
    pageNumbering: composition?.pageNumbering ?? null,
    warnings: summarizeWarnings(composition),
  };
}

/**
 * A read-only summary of `composition.raw.warnings` (#306's raw sidecar for
 * captured-but-unmodeled OOXML) — `{ count, warnings }` so a view can badge
 * the count without re-deriving `warnings.length` itself. Empty for a
 * missing/malformed sidecar, never throws.
 */
export function summarizeWarnings(composition) {
  const warnings = Array.isArray(composition?.raw?.warnings) ? composition.raw.warnings : [];
  return { count: warnings.length, warnings };
}
