import { BorderStyle, Paragraph, Table, Tab, TabStopPosition, TabStopType, TextRun } from 'docx';
import type { IBorderOptions, IBordersOptions, TabStopDefinition } from 'docx';
import type { HeaderFooterVariant } from '../ast/index.js';
import {
  cascadeStyle,
  renderCellRuns,
  type HeaderFooterCell,
  type HeaderFooterFieldContext,
  type HeaderFooterRunChild,
  type HeaderFooterVisualStyle,
} from './header-footer-fields.js';
import { imageFieldWarnings } from './header-footer-images.js';
import { buildTable } from './header-footer-tables.js';

// Local indexed-access aliases (see header-footer-fields.ts for the same
// pattern): the AST barrel (`src/ast/index.ts`) exports only
// composition-level types, so the region/rule-line shapes are derived
// structurally off `HeaderFooterVariant` rather than the generator reaching
// into `ast/header-footer-schemas.ts` internals (module-boundary rule).
export type HeaderFooterRegion = NonNullable<HeaderFooterVariant['header']>;
export type HeaderFooterRuleLine = NonNullable<HeaderFooterRegion['ruleLine']>;

/** Which paragraph border edge a region's rule line renders on. */
export type RuleLineEdge = 'top' | 'bottom';

// OOXML `w:sz` (eighths of a point) floor — an enabled rule line must stay
// visible even when `widthTwips` is omitted, zero, or rounds down to it.
const MIN_BORDER_SIZE = 2;

// Verified against real docx output (Packer round-trip): widthTwips=8
// produces `w:sz="3"`. Twips (1/20 pt) -> eighths-of-a-point is nominally
// *0.4 (1/20 / (1/8) = 0.4); this constant documents that derivation rather
// than leaving `0.4` unexplained at the call site.
const BORDER_SIZE_PER_TWIP = 0.4;

// docx's BorderStyle enum values line up with the keywords SpecR itself
// authors for `ruleLine.style`. The AST schema leaves `style` as an open
// string (round-trips arbitrary OOXML border styles it doesn't otherwise
// model), so this table is deliberately non-exhaustive — anything absent or
// unrecognized falls back to BorderStyle.SINGLE.
const RULE_LINE_BORDER_STYLES: Readonly<
  Record<string, (typeof BorderStyle)[keyof typeof BorderStyle]>
> = {
  single: BorderStyle.SINGLE,
  double: BorderStyle.DOUBLE,
  dashed: BorderStyle.DASHED,
  dotted: BorderStyle.DOTTED,
  thick: BorderStyle.THICK,
};

function ruleLineBorderStyle(
  style: string | undefined
): (typeof BorderStyle)[keyof typeof BorderStyle] {
  if (style === undefined) return BorderStyle.SINGLE;
  return RULE_LINE_BORDER_STYLES[style] ?? BorderStyle.SINGLE;
}

function ruleLineBorderSize(widthTwips: number | undefined): number {
  const scaled =
    widthTwips === undefined ? MIN_BORDER_SIZE : Math.round(widthTwips * BORDER_SIZE_PER_TWIP);
  return Math.max(scaled, MIN_BORDER_SIZE);
}

/**
 * A paragraph border for `region.ruleLine`, or `undefined` when the rule
 * line is absent or not explicitly `enabled: true`.
 */
export function ruleLineBorder(rule: HeaderFooterRuleLine | undefined): IBorderOptions | undefined {
  if (rule === undefined || rule.enabled !== true) return undefined;
  const border: IBorderOptions = {
    style: ruleLineBorderStyle(rule.style),
    size: ruleLineBorderSize(rule.widthTwips),
  };
  return rule.color === undefined ? border : { ...border, color: rule.color };
}

const CENTER_TAB_STOP: TabStopDefinition = {
  type: TabStopType.CENTER,
  position: TabStopPosition.MAX / 2,
};
const RIGHT_TAB_STOP: TabStopDefinition = {
  type: TabStopType.RIGHT,
  position: TabStopPosition.MAX,
};

// A tab MUST be its own TextRun (`new TextRun({ children: [new Tab()] })`),
// never a bare `new Tab()` pushed straight into `Paragraph.children`: `Tab`
// structurally satisfies docx's `ParagraphChild` element shape even though
// it is not one of that union's members, so a bare Tab typechecks but
// renders `<w:tab/>` as an invalid direct sibling of `<w:r>` in the OOXML —
// every run-level element, tabs included, belongs inside a `<w:r>`.
function tabRun(): TextRun {
  return new TextRun({ children: [new Tab()] });
}

// A tab always jumps to the NEXT tab stop from wherever the cursor currently
// sits, so whether a tab is needed depends only on whether content further
// right exists — never on whether nearer-left cells are empty. A
// left+right-only region (center empty) still needs BOTH tabs: one to clear
// the (empty) center stop, one to reach the right stop. Collapsing this to a
// single tab would land right-cell content at the center stop instead of the
// right margin — see header-footer-regions.test.ts for the pinned case.
//
// The tab flags key off the ALREADY-RENDERED run counts, not `cellHasContent`:
// a cell whose only field fails to render (e.g. an undecodable image, #308)
// counts as content structurally but produces zero runs, so basing a tab on
// `cellHasContent` would emit a dangling `<w:tab/>` with nothing after it
// (center text + a broken right image left a trailing right tab). Deriving
// from run counts treats an empty-rendering cell as empty — no dangling tab —
// and renders each cell exactly once instead of walking its fields twice.
function regionChildren(
  region: HeaderFooterRegion | undefined,
  ctx: HeaderFooterFieldContext,
  style: HeaderFooterVisualStyle | undefined
): readonly HeaderFooterRunChild[] {
  const leftRuns = renderCellRuns(region?.left, ctx, style);
  const centerRuns = renderCellRuns(region?.center, ctx, style);
  const rightRuns = renderCellRuns(region?.right, ctx, style);
  const needsCenterTab = centerRuns.length > 0 || rightRuns.length > 0;
  const needsRightTab = rightRuns.length > 0;
  return [
    ...leftRuns,
    ...(needsCenterTab ? [tabRun()] : []),
    ...centerRuns,
    ...(needsRightTab ? [tabRun()] : []),
    ...rightRuns,
  ];
}

/** Every image-field warning `cell` produces, each prefixed with `location`. */
function cellImageWarnings(
  cell: HeaderFooterCell | undefined,
  location: string
): readonly string[] {
  if (cell?.content === undefined) return [];
  return cell.content.flatMap((field) => imageFieldWarnings(field, location));
}

/**
 * Every image-field warning across `region`'s left/center/right cells (#308),
 * each prefixed with `location.<cell>` (e.g. `"header.left"`). `[]` for an
 * undefined region or a region whose image fields (if any) carry no
 * warnings.
 */
export function regionImageWarnings(
  region: HeaderFooterRegion | undefined,
  location: string
): readonly string[] {
  return [
    ...cellImageWarnings(region?.left, `${location}.left`),
    ...cellImageWarnings(region?.center, `${location}.center`),
    ...cellImageWarnings(region?.right, `${location}.right`),
  ];
}

// `Paragraph`'s `border` option is a full `IBordersOptions` map (top/bottom/
// left/right/between); a region only ever sets the one edge its rule line
// occupies, so this builds that single-key object (or omits the option
// entirely) rather than spreading a possibly-undefined border inline.
function paragraphBorderOption(
  border: IBorderOptions | undefined,
  edge: RuleLineEdge
): { readonly border?: IBordersOptions } {
  if (border === undefined) return {};
  return edge === 'top' ? { border: { top: border } } : { border: { bottom: border } };
}

/**
 * One `Paragraph` for a header/footer region: left/center/right cells laid
 * out over a fixed two-tab-stop layout (CENTER at half-width, RIGHT at
 * full-width), with `region.ruleLine` (if enabled) rendered as a paragraph
 * border on `ruleLineEdge`.
 *
 * `undefined` when the region renders no content and has no enabled rule
 * line. The gate is the ACTUAL rendered children, not structural presence: a
 * region whose only field is an unrenderable image (e.g. missing dimensions,
 * #308) has content per `cellHasContent` but produces zero runs, and emitting
 * a paragraph for it would serialize an empty `<w:p/>` (the broken image
 * still surfaces via `regionImageWarnings`, independently of this paragraph).
 * A region with an enabled rule line but every cell empty still returns a
 * single contentless paragraph, so the rule line still renders.
 */
export function buildRegionParagraph(
  region: HeaderFooterRegion | undefined,
  inheritedStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext,
  ruleLineEdge: RuleLineEdge
): Paragraph | undefined {
  const border = ruleLineBorder(region?.ruleLine);
  const style = cascadeStyle(region?.style, inheritedStyle);
  const children = regionChildren(region, ctx, style);
  if (children.length === 0 && border === undefined) return undefined;

  return new Paragraph({
    children,
    tabStops: [CENTER_TAB_STOP, RIGHT_TAB_STOP],
    ...paragraphBorderOption(border, ruleLineEdge),
  });
}

/**
 * `[paragraph?, table?]` for one region, in that fixed order (#309):
 * everything {@link buildRegionParagraph} already renders for `region`'s
 * left/center/right cells and rule line, followed by `region.table` (via
 * `header-footer-tables.ts`'s `buildTable`) when present. `[]` when the
 * region renders neither. Verified against real docx `Packer` output:
 * `Header`/`Footer`'s `children` option accepts a mixed
 * `(Paragraph | Table)[]`, and a paragraph followed by a table serializes in
 * that order.
 *
 * `region.style` is cascaded into the table exactly once, here —
 * `buildTable` itself passes the style it's given straight through to every
 * row/cell rather than re-cascading (see `header-footer-tables.ts`'s
 * `buildTable` doc comment), so this is the only cascade step for the table
 * branch, mirroring the cascade `buildRegionParagraph` already performs
 * internally for the paragraph branch.
 */
export function buildRegionChildren(
  region: HeaderFooterRegion | undefined,
  inheritedStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext,
  ruleLineEdge: RuleLineEdge
): readonly (Paragraph | Table)[] {
  const paragraph = buildRegionParagraph(region, inheritedStyle, ctx, ruleLineEdge);
  const style = cascadeStyle(region?.style, inheritedStyle);
  const table = buildTable(region?.table, style, ctx);
  return [...(paragraph !== undefined ? [paragraph] : []), ...(table !== undefined ? [table] : [])];
}
