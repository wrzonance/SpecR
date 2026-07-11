import { PageNumber, TextRun } from 'docx';
import type { HeaderFooterFieldKind, HeaderFooterVariant } from '../ast/index.js';

// Local indexed-access aliases: the AST barrel (`src/ast/index.ts`) exports
// only the composition-level types (HeaderFooterComposition/Variant/
// FieldKind) — the nested region/cell/field/style shapes stay unexported
// (ADR-040 keeps them JSONB-open via `.catchall`). Callers derive them
// structurally off `HeaderFooterVariant` instead of the generator reaching
// into `ast/header-footer-schemas.ts` internals (module-boundary rule).
type HeaderFooterRegion = NonNullable<HeaderFooterVariant['header']>;
export type HeaderFooterCell = NonNullable<HeaderFooterRegion['left']>;
export type HeaderFooterField = NonNullable<HeaderFooterCell['content']>[number];
export type HeaderFooterVisualStyle = NonNullable<HeaderFooterVariant['style']>;

/** Header/footer field values available at generation time (#303). */
export interface HeaderFooterFieldValues {
  readonly date?: string;
  readonly packageName?: string;
  readonly revisionName?: string;
  readonly revisionLabel?: string;
  readonly projectName?: string;
  readonly projectNumber?: string;
  readonly clientName?: string;
  readonly clientNumber?: string;
}

/**
 * Generation-time context for resolving header/footer fields. `sectionNumber`
 * / `sectionTitle` come from the `SpecTree` being generated — never from the
 * caller's stored field values (#303 acceptance: "Spec number/title in H/F
 * match the generated SpecTree, not duplicated config values"). `current` /
 * `issuance` back the source-selectable identity fields; a field with
 * `source: 'issuance'` reads `issuance` with a per-key fallback to `current`
 * when the requested key is absent there (or `issuance` itself is absent).
 */
export interface HeaderFooterFieldContext {
  readonly sectionNumber: string;
  readonly sectionTitle: string;
  readonly current: HeaderFooterFieldValues;
  readonly issuance?: HeaderFooterFieldValues;
}

type PageNumberToken = (typeof PageNumber)[keyof typeof PageNumber];

/**
 * A resolved field value, tagged so the renderer can never mistake literal
 * text for a docx Word-field sentinel. `PageNumberToken` is structurally
 * just a plain string (`'CURRENT'`, `'TOTAL_PAGES'`,
 * `'TOTAL_PAGES_IN_SECTION'`, `'SECTION'`) — docx's own `Run` constructor
 * pattern-matches any *raw string* passed via its `children` array against
 * those four values and silently swaps in a Word field code, regardless of
 * whether the string is a real sentinel or a literal/value field's text that
 * happens to collide with one. Tagging every value with its origin (`'text'`
 * vs `'pageField'`) at the type level is what lets `renderFieldRun` route
 * each one through the correct, collision-proof docx API (see there).
 */
export type FieldValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'pageField'; readonly token: PageNumberToken };

function textValue(text: string): FieldValue {
  return { kind: 'text', text };
}

function pageFieldValue(token: PageNumberToken): FieldValue {
  return { kind: 'pageField', token };
}

type FieldResolver = (
  field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
) => readonly FieldValue[];

function resolveValueField(key: keyof HeaderFooterFieldValues): FieldResolver {
  return (field, ctx) => {
    const value =
      field.source === 'issuance' ? (ctx.issuance?.[key] ?? ctx.current[key]) : ctx.current[key];
    return value === undefined ? [] : [textValue(value)];
  };
}

function resolveSectionNumber(
  _field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
): readonly FieldValue[] {
  return [textValue(ctx.sectionNumber)];
}

function resolveSectionTitle(
  _field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
): readonly FieldValue[] {
  return [textValue(ctx.sectionTitle)];
}

// Word field code, never a literal number — the page is unknown until Word
// paginates the document (#303 acceptance: "Page number renders as a Word
// field, not a literal number"). `field.label`, when set, prefixes the field
// with literal text (e.g. label: 'Page' -> "Page" + <PAGE field>). The label
// is tagged `'text'` even when it happens to equal a sentinel string (e.g.
// label: 'SECTION') — see the FieldValue doc comment.
function resolvePageNumber(field: HeaderFooterField): readonly FieldValue[] {
  const token = pageFieldValue(PageNumber.CURRENT);
  return field.label === undefined ? [token] : [textValue(field.label), token];
}

function resolveLiteral(field: HeaderFooterField): readonly FieldValue[] {
  return field.text === undefined ? [] : [textValue(field.text)];
}

// Every HeaderFooterFieldKind has exactly one resolver here, enforced at
// compile time: the Record<HeaderFooterFieldKind, FieldResolver> annotation
// rejects a missing or unrecognized key. `field.format` is validated by the
// AST schema but not applied by any resolver in this pass — #303's scope is
// text/separator/page-number/rule-line fidelity, not per-field formatting;
// `field.prefix`/`field.suffix` are deferred the same way (no #303
// acceptance criterion requires them — see the coverage test).
const FIELD_RESOLVERS: Record<HeaderFooterFieldKind, FieldResolver> = {
  date: resolveValueField('date'),
  sectionTitle: resolveSectionTitle,
  sectionNumber: resolveSectionNumber,
  pageNumber: resolvePageNumber,
  packageName: resolveValueField('packageName'),
  revisionName: resolveValueField('revisionName'),
  revisionLabel: resolveValueField('revisionLabel'),
  projectName: resolveValueField('projectName'),
  projectNumber: resolveValueField('projectNumber'),
  clientName: resolveValueField('clientName'),
  clientNumber: resolveValueField('clientNumber'),
  literal: resolveLiteral,
};

/**
 * Resolve one field to its ordered content: literal text and/or a
 * page-number field code. Total, never throws.
 */
export function resolveFieldChildren(
  field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
): readonly FieldValue[] {
  return FIELD_RESOLVERS[field.kind](field, ctx);
}

/**
 * True iff `cell` has no content to render — the shared emptiness guard so
 * callers (here and in `header-footer-regions.ts`) never chain optional
 * access themselves.
 */
export function cellIsEmpty(cell: HeaderFooterCell | undefined): boolean {
  return cell?.content === undefined || cell.content.length === 0;
}

/**
 * True iff `cell` resolves to at least one real field value for `ctx` — not
 * merely a non-empty `content` array. A field can be structurally present
 * yet resolve to nothing (`{ kind: 'literal' }` with no `text`, or a value
 * field whose key is absent from `ctx.current`/`ctx.issuance`), and regions
 * need to know whether a cell would actually render before deciding to emit
 * a paragraph or a tab stop for it.
 */
export function cellHasContent(
  cell: HeaderFooterCell | undefined,
  ctx: HeaderFooterFieldContext
): boolean {
  if (cellIsEmpty(cell)) return false;
  return (cell?.content ?? []).some((field) => resolveFieldChildren(field, ctx).length > 0);
}

/** docx TextRun run-property options mapped from a resolved visual style. */
export interface HeaderFooterRunOptions {
  readonly font?: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly allCaps?: boolean;
  readonly color?: string;
}

export function headerFooterRunOptions(
  style: HeaderFooterVisualStyle | undefined
): HeaderFooterRunOptions {
  if (style === undefined) return {};
  const out: { -readonly [K in keyof HeaderFooterRunOptions]: HeaderFooterRunOptions[K] } = {};
  if (style.fontFamily !== undefined) out.font = style.fontFamily;
  if (style.fontSizeHalfPt !== undefined) out.size = style.fontSizeHalfPt;
  if (style.bold !== undefined) out.bold = style.bold;
  if (style.italic !== undefined) out.italics = style.italic;
  if (style.caps !== undefined) out.allCaps = style.caps;
  if (style.color !== undefined) out.color = style.color;
  return out;
}

/**
 * Right-to-left, most-specific-wins shallow merge over the defined layers
 * (undefined layers skipped). Callers pass layers most-specific first, e.g.
 * `cascadeStyle(cell.style, region.style, compositionStyle)`.
 */
export function cascadeStyle(
  ...layers: readonly (HeaderFooterVisualStyle | undefined)[]
): HeaderFooterVisualStyle | undefined {
  const defined = layers.filter((layer): layer is HeaderFooterVisualStyle => layer !== undefined);
  if (defined.length === 0) return undefined;
  return defined.reduceRight<HeaderFooterVisualStyle>(
    (merged, layer) => ({ ...merged, ...layer }),
    {}
  );
}

/**
 * One TextRun per resolved value in `field`'s children — usually exactly
 * one, but a `pageNumber` field with a `label` resolves to two: a literal
 * label run followed by the real Word PAGE-field run. `[]` when the field
 * resolves to nothing.
 *
 * Every `'text'`-tagged value is passed through TextRun's `text` option —
 * never `children` — which builds a plain `<w:t>` run directly and never
 * runs docx's Run-constructor sentinel switch (see the `FieldValue` doc
 * comment). Only a `'pageField'`-tagged value goes through `children`, and
 * that value is always the real `PageNumber.CURRENT` token `resolvePageNumber`
 * produced, never spec-author text.
 */
export function renderFieldRun(
  field: HeaderFooterField,
  ctx: HeaderFooterFieldContext,
  style: HeaderFooterVisualStyle | undefined
): readonly TextRun[] {
  const options = headerFooterRunOptions(style);
  return resolveFieldChildren(field, ctx).map((value) =>
    value.kind === 'pageField'
      ? new TextRun({ children: [value.token], ...options })
      : new TextRun({ text: value.text, ...options })
  );
}

/**
 * Render one cell's fields in order, interleaving `cell.separator` (default a
 * single space) between entries that actually resolve to output. A field
 * that resolves to nothing (e.g. `{ kind: 'literal' }` with no `text`, or a
 * value field whose key is absent from `ctx`) is skipped entirely and never
 * triggers a separator on either side — the separator count always tracks
 * resolved output, not `cell.content`'s structural length. `[]` for an
 * absent/empty cell.
 *
 * The separator run carries the same cascaded cell style as the field runs it
 * divides — so a bold/red/Arial cell's ` | ` divider (and even the default
 * space's font-derived width) stays visually consistent with its fields.
 *
 * The default separator can visually double up with a literal field's own
 * trailing space (e.g. a literal "Page " immediately followed by a
 * pageNumber field). This is not auto-corrected: the separator is explicit
 * spec-author config (set `cell.separator: ''` to avoid it), and a literal
 * field's text is spec-author content SpecR never rewrites.
 */
export function renderCellRuns(
  cell: HeaderFooterCell | undefined,
  ctx: HeaderFooterFieldContext,
  inheritedStyle: HeaderFooterVisualStyle | undefined
): readonly TextRun[] {
  if (cell === undefined || cell.content === undefined || cell.content.length === 0) return [];
  const style = cascadeStyle(cell.style, inheritedStyle);
  const separatorOptions = headerFooterRunOptions(style);
  const separator = cell.separator ?? ' ';
  const runs: TextRun[] = [];
  let hasRenderedField = false;
  for (const field of cell.content) {
    const fieldRuns = renderFieldRun(field, ctx, style);
    if (fieldRuns.length === 0) continue;
    if (hasRenderedField) runs.push(new TextRun({ text: separator, ...separatorOptions }));
    runs.push(...fieldRuns);
    hasRenderedField = true;
  }
  return runs;
}
