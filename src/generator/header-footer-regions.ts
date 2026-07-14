import { BorderStyle, Paragraph, Tab, TabStopPosition, TabStopType, TextRun } from 'docx';
import type { IBorderOptions, IBordersOptions, TabStopDefinition } from 'docx';
import type { HeaderFooterVariant } from '../ast/index.js';
import {
  cascadeStyle,
  cellHasContent,
  renderCellRuns,
  type HeaderFooterCell,
  type HeaderFooterFieldContext,
  type HeaderFooterRunChild,
  type HeaderFooterVisualStyle,
} from './header-footer-fields.js';
import { imageFieldWarnings } from './header-footer-images.js';

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
function regionChildren(
  region: HeaderFooterRegion | undefined,
  ctx: HeaderFooterFieldContext,
  style: HeaderFooterVisualStyle | undefined
): readonly HeaderFooterRunChild[] {
  const needsCenterTab = cellHasContent(region?.center, ctx) || cellHasContent(region?.right, ctx);
  const needsRightTab = cellHasContent(region?.right, ctx);
  return [
    ...renderCellRuns(region?.left, ctx, style),
    ...(needsCenterTab ? [tabRun()] : []),
    ...renderCellRuns(region?.center, ctx, style),
    ...(needsRightTab ? [tabRun()] : []),
    ...renderCellRuns(region?.right, ctx, style),
  ];
}

function regionHasContent(
  region: HeaderFooterRegion | undefined,
  ctx: HeaderFooterFieldContext
): boolean {
  return (
    cellHasContent(region?.left, ctx) ||
    cellHasContent(region?.center, ctx) ||
    cellHasContent(region?.right, ctx)
  );
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
 * `undefined` when the region has no content and no enabled rule line. A
 * region with an enabled rule line but every cell empty still returns a
 * single contentless paragraph, so the rule line still renders.
 */
export function buildRegionParagraph(
  region: HeaderFooterRegion | undefined,
  inheritedStyle: HeaderFooterVisualStyle | undefined,
  ctx: HeaderFooterFieldContext,
  ruleLineEdge: RuleLineEdge
): Paragraph | undefined {
  const border = ruleLineBorder(region?.ruleLine);
  if (!regionHasContent(region, ctx) && border === undefined) return undefined;

  const style = cascadeStyle(region?.style, inheritedStyle);
  return new Paragraph({
    children: regionChildren(region, ctx, style),
    tabStops: [CENTER_TAB_STOP, RIGHT_TAB_STOP],
    ...paragraphBorderOption(border, ruleLineEdge),
  });
}
