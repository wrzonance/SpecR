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

// A resolved field value is either literal text or a docx Word-field
// sentinel (PageNumber.CURRENT and friends) — never a literal numeric string
// standing in for a real field. The union is kept (not collapsed to
// `string`) so callers can still tell "this is a field code" apart from
// "this is text", even though PageNumberToken is structurally a subset of
// string.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- see comment above
export type FieldValue = string | PageNumberToken;

type FieldResolver = (
  field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
) => readonly FieldValue[];

function resolveValueField(key: keyof HeaderFooterFieldValues): FieldResolver {
  return (field, ctx) => {
    const value =
      field.source === 'issuance' ? (ctx.issuance?.[key] ?? ctx.current[key]) : ctx.current[key];
    return value === undefined ? [] : [value];
  };
}

function resolveSectionNumber(
  _field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
): readonly FieldValue[] {
  return [ctx.sectionNumber];
}

function resolveSectionTitle(
  _field: HeaderFooterField,
  ctx: HeaderFooterFieldContext
): readonly FieldValue[] {
  return [ctx.sectionTitle];
}

// Word field code, never a literal number — the page is unknown until Word
// paginates the document (#303 acceptance: "Page number renders as a Word
// field, not a literal number"). `field.label`, when set, prefixes the field
// with literal text (e.g. label: 'Page' -> "Page" + <PAGE field>).
function resolvePageNumber(field: HeaderFooterField): readonly FieldValue[] {
  const token: FieldValue = PageNumber.CURRENT;
  return field.label === undefined ? [token] : [field.label, token];
}

function resolveLiteral(field: HeaderFooterField): readonly FieldValue[] {
  return field.text === undefined ? [] : [field.text];
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

/** One TextRun for a single field; its resolved children carry the cascaded style. */
export function renderFieldRun(
  field: HeaderFooterField,
  ctx: HeaderFooterFieldContext,
  style: HeaderFooterVisualStyle | undefined
): TextRun {
  return new TextRun({
    children: [...resolveFieldChildren(field, ctx)],
    ...headerFooterRunOptions(style),
  });
}

/**
 * Render one cell's fields in order, interleaving `cell.separator` (default a
 * single space) between entries. A cell with zero or one resolved fields
 * never needs — and never emits — a separator. `[]` for an absent/empty cell.
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
  const separator = cell.separator ?? ' ';
  const runs: TextRun[] = [];
  cell.content.forEach((field, index) => {
    if (index > 0) runs.push(new TextRun({ text: separator }));
    runs.push(renderFieldRun(field, ctx, style));
  });
  return runs;
}
