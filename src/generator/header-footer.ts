import { Header, Footer } from 'docx';
import { defaultVariant } from '../ast/index.js';
import type { HeaderFooterComposition, HeaderFooterVariant } from '../ast/index.js';
import { cascadeStyle } from './header-footer-fields.js';
import type { HeaderFooterFieldContext, HeaderFooterVisualStyle } from './header-footer-fields.js';
import { buildRegionChildren, regionImageWarnings } from './header-footer-regions.js';
import { tableWarnings, type HeaderFooterTable } from './header-footer-tables.js';

// `Partial<T>` alone does not strip `| undefined` from a value type under
// `exactOptionalPropertyTypes` — it only adds `?`, so a `Partial<{ default:
// Header }>` field would still accept `{ default: undefined }`, which
// exactOptionalPropertyTypes rejects. This mapped type instead excludes
// `undefined` from each property's value while keeping the property optional.
type DefinedProps<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

type HeaderTriple = DefinedProps<{ default: Header; first: Header; even: Header }>;
type FooterTriple = DefinedProps<{ default: Footer; first: Footer; even: Footer }>;

/**
 * The rendered docx artifacts + resolved metadata for one
 * {@link HeaderFooterComposition} (#303). Pure output of
 * {@link renderHeaderFooterComposition} — never mutated after construction.
 */
export interface HeaderFooterRenderResult {
  readonly headers?: HeaderTriple;
  readonly footers?: FooterTriple;
  readonly titlePage: boolean;
  readonly evenAndOddHeaders: boolean;
  readonly pageNumberStart?: number;
  readonly warnings: readonly string[];
}

function buildHeader(
  variant: HeaderFooterVariant | undefined,
  compositionStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext
): Header | undefined {
  const inheritedStyle = cascadeStyle(variant?.style, compositionStyle);
  const children = buildRegionChildren(variant?.header, inheritedStyle, ctx, 'bottom');
  return children.length === 0 ? undefined : new Header({ children });
}

function buildFooter(
  variant: HeaderFooterVariant | undefined,
  compositionStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext
): Footer | undefined {
  const inheritedStyle = cascadeStyle(variant?.style, compositionStyle);
  const children = buildRegionChildren(variant?.footer, inheritedStyle, ctx, 'top');
  return children.length === 0 ? undefined : new Footer({ children });
}

function buildHeaders(
  compositionStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext,
  defaultV: HeaderFooterVariant,
  firstV: HeaderFooterVariant | undefined,
  evenV: HeaderFooterVariant | undefined
): HeaderTriple | undefined {
  const out: HeaderTriple = {};
  const defaultHeader = buildHeader(defaultV, compositionStyle, ctx);
  const firstHeader = buildHeader(firstV, compositionStyle, ctx);
  const evenHeader = buildHeader(evenV, compositionStyle, ctx);
  if (defaultHeader !== undefined) out.default = defaultHeader;
  if (firstHeader !== undefined) out.first = firstHeader;
  if (evenHeader !== undefined) out.even = evenHeader;
  return Object.keys(out).length === 0 ? undefined : out;
}

function buildFooters(
  compositionStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext,
  defaultV: HeaderFooterVariant,
  firstV: HeaderFooterVariant | undefined,
  evenV: HeaderFooterVariant | undefined
): FooterTriple | undefined {
  const out: FooterTriple = {};
  const defaultFooter = buildFooter(defaultV, compositionStyle, ctx);
  const firstFooter = buildFooter(firstV, compositionStyle, ctx);
  const evenFooter = buildFooter(evenV, compositionStyle, ctx);
  if (defaultFooter !== undefined) out.default = defaultFooter;
  if (firstFooter !== undefined) out.first = firstFooter;
  if (evenFooter !== undefined) out.even = evenFooter;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * `pageNumbering.startAt` (defaulting to 1) when the composition restarts
 * numbering per spec section; `undefined` for continuous numbering or when
 * `pageNumbering` is absent entirely.
 */
function resolvePageNumberStart(
  pageNumbering: HeaderFooterComposition['pageNumbering']
): number | undefined {
  if (pageNumbering?.mode !== 'restartPerSpec') return undefined;
  return pageNumbering.startAt ?? 1;
}

/**
 * Every image-field warning (#308, ADR-069) across the default/first/even
 * header AND footer regions, in a fixed, deterministic order: header
 * default, header first, header even, then footer default, first, even.
 * Locations are `"header"`/`"footer"` for the default variant and
 * `"header.first"`/`"footer.even"` etc. for named variants — each further
 * suffixed with `.left`/`.center`/`.right` by {@link regionImageWarnings}.
 * `[]` when no region carries an image field with a warning.
 */
function collectImageWarnings(
  defaultV: HeaderFooterVariant,
  firstV: HeaderFooterVariant | undefined,
  evenV: HeaderFooterVariant | undefined
): readonly string[] {
  return [
    ...regionImageWarnings(defaultV.header, 'header'),
    ...regionImageWarnings(firstV?.header, 'header.first'),
    ...regionImageWarnings(evenV?.header, 'header.even'),
    ...regionImageWarnings(defaultV.footer, 'footer'),
    ...regionImageWarnings(firstV?.footer, 'footer.first'),
    ...regionImageWarnings(evenV?.footer, 'footer.even'),
  ];
}

/**
 * `variant?.[key]?.table` pre-resolved into a single call. Factored out so
 * {@link collectTableWarnings}'s own body reads as flat function calls (zero
 * optional-chain operators) rather than inlining this *doubly*-nested
 * optional chain six times — the naive inline version measured ESLint
 * `complexity: 11` against the enforced cap of 10, a trap
 * {@link collectImageWarnings}'s single-nested `variant?.header` did not hit.
 */
function regionTable(
  variant: HeaderFooterVariant | undefined,
  key: 'header' | 'footer'
): HeaderFooterTable | undefined {
  return variant?.[key]?.table;
}

/**
 * Every image-field warning inside a table cell (#309, ADR-071) across the
 * default/first/even header AND footer regions' `table` slot, in the same
 * fixed order as {@link collectImageWarnings}. `[]` when no table cell
 * carries an image field.
 */
function collectTableWarnings(
  defaultV: HeaderFooterVariant,
  firstV: HeaderFooterVariant | undefined,
  evenV: HeaderFooterVariant | undefined
): readonly string[] {
  return [
    ...tableWarnings(regionTable(defaultV, 'header'), 'header'),
    ...tableWarnings(regionTable(firstV, 'header'), 'header.first'),
    ...tableWarnings(regionTable(evenV, 'header'), 'header.even'),
    ...tableWarnings(regionTable(defaultV, 'footer'), 'footer'),
    ...tableWarnings(regionTable(firstV, 'footer'), 'footer.first'),
    ...tableWarnings(regionTable(evenV, 'footer'), 'footer.even'),
  ];
}

/**
 * Render one {@link HeaderFooterComposition} into docx `Header`/`Footer`
 * instances plus the section-level metadata needed to wire them up
 * (`titlePage`, `evenAndOddHeaders`, `pageNumberStart`). Pure and total —
 * never throws; `composition` is already-validated plain data (ADR-021).
 *
 * `composition.style` (the v1 top-level style) cascades as the outermost,
 * lowest-precedence layer into every variant — default, first, AND even —
 * so a composition-root font/size still applies to first/even pages that
 * don't set their own `style`.
 */
export function renderHeaderFooterComposition(
  composition: HeaderFooterComposition,
  ctx: HeaderFooterFieldContext
): HeaderFooterRenderResult {
  const compositionStyle = composition.style;
  const defaultV = defaultVariant(composition);
  const firstV = composition.variants?.first;
  const evenV = composition.variants?.even;

  const headers = buildHeaders(compositionStyle, ctx, defaultV, firstV, evenV);
  const footers = buildFooters(compositionStyle, ctx, defaultV, firstV, evenV);
  const pageNumberStart = resolvePageNumberStart(composition.pageNumbering);
  const rawWarnings = composition.raw?.warnings ?? [];
  const imageWarnings = collectImageWarnings(defaultV, firstV, evenV);
  const tableWarningsList = collectTableWarnings(defaultV, firstV, evenV);

  return {
    ...(headers !== undefined ? { headers } : {}),
    ...(footers !== undefined ? { footers } : {}),
    titlePage: firstV !== undefined,
    evenAndOddHeaders: evenV !== undefined,
    ...(pageNumberStart !== undefined ? { pageNumberStart } : {}),
    warnings: [...rawWarnings, ...imageWarnings, ...tableWarningsList],
  };
}
