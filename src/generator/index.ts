import { Document, Paragraph, TextRun, Packer, HeadingLevel } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
import { buildObjectBlocks, ImportedObjectBlock } from './object-block.js';
import { buildFrontMatter, type ManualMeta } from './front-matter.js';
import type {
  SpecNode,
  SpecTree,
  StyleProperties,
  StyleRule,
  HeaderFooterComposition,
  PageSize,
} from '../ast/index.js';
import { resolvePageSize, toDocxPageSize, type PageSizeOption } from './page-size.js';
import { GeneratorError } from './error.js';
import { buildSpecNumberingConfig, getNodeLevel } from './numbering.js';
import { buildRuleMap, paragraphStyleOptions, runStyleOptions } from './styles.js';
import type { StyleRuleMap } from './styles.js';
import {
  displaySectionNumber,
  formatSectionReferences,
  type SectionNumberFormat,
} from '../lib/section-number.js';
import { renderHeaderFooterComposition } from './header-footer.js';
import type { HeaderFooterRenderResult } from './header-footer.js';
import type { HeaderFooterFieldContext, HeaderFooterFieldValues } from './header-footer-fields.js';
import {
  collectVanishCharacterStyleIds,
  vanishCharacterStyleOptions,
} from './object-vanish-styles.js';
import type { IStylesOptions } from 'docx';

export { generateSec } from './sec/index.js';
export { renderMarkdown } from './markdown.js';
export { renderHeaderFooterComposition } from './header-footer.js';
export type { ManualMeta, ManualSectionListing } from './front-matter.js';
export type { HeaderFooterRenderResult } from './header-footer.js';
export type { HeaderFooterFieldContext, HeaderFooterFieldValues } from './header-footer-fields.js';

const SPEC_NUM_REF = 'spec-numbering' as const;

/** Header/footer generation input (#303): the composition to render plus the
 * field-value sources (`current` / `issuance`) it may draw on. `sectionNumber`
 * / `sectionTitle` are never taken from here — they always come from the
 * `SpecTree` being generated, so a generated header/footer can't drift from
 * the section it's attached to. */
export interface HeaderFooterGenerationInput {
  readonly composition: HeaderFooterComposition;
  readonly current: HeaderFooterFieldValues;
  readonly issuance?: HeaderFooterFieldValues;
}

export interface GenerateDocxOptions {
  readonly sectionNumberFormat?: SectionNumberFormat;
  readonly headerFooter?: HeaderFooterGenerationInput;
}

// Per-section rendering context. `reference` selects the numbering instance so a
// manual can give each section its own (per-section restart, ADR-017).
interface SectionContext {
  readonly format: SectionNumberFormat;
  readonly reference: string;
  readonly rules?: StyleRuleMap;
}

function sectionContext(
  format: SectionNumberFormat,
  reference: string,
  rules?: StyleRuleMap
): SectionContext {
  return { format, reference, ...(rules !== undefined ? { rules } : {}) };
}

// Backs both the note and continuation/plain emitNode call sites (#497):
// they were byte-identical bodies before this change, and adding the same
// `pageBreakBefore` conditional spread to each independently trips
// sonarjs/no-identical-functions — the rule's body-size threshold no longer
// clears once both grow past a single statement. No external references to
// the pre-#497 `noteParagraph`/`plainParagraph` names exist, so merging them
// is a clean, low-risk single-file change.
function simpleParagraph(text: string, pageBreakBefore?: boolean): Paragraph {
  return new Paragraph({
    children: [new TextRun(text)],
    ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
  });
}

function numberedParagraph(
  text: string,
  level: number,
  reference: string,
  props?: StyleProperties,
  pageBreakBefore?: boolean
): Paragraph {
  return new Paragraph({
    numbering: { reference, level },
    children: [new TextRun({ text, ...runStyleOptions(props?.rPr) })],
    ...paragraphStyleOptions(props?.pPr),
    ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
  });
}

// Word's Heading1 style renders blue by default; spec deliverables are black
// unless a style template's 'part' rule says otherwise (#510).
const DEFAULT_TITLE_COLOR = '000000';

function titleParagraphColor(rules?: StyleRuleMap): string {
  return rules?.get('part')?.rPr?.color ?? DEFAULT_TITLE_COLOR;
}

// Section titles are Heading1 so the manual's Word TOC field (headingStyleRange
// '1-1') resolves exactly one entry per section. Harmless in single-section
// output, which carries no TOC. The run's explicit color overrides Word's
// Heading1 style-level blue (#510) — deliberately narrower than
// runStyleOptions (styles.ts marks color out of scope for #32).
function titleParagraph(text: string, rules?: StyleRuleMap): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, color: titleParagraphColor(rules) })],
  });
}

// One section's rendered children: ordinary numbered/note/continuation
// paragraphs (Paragraph, content-control-anchored as SdtBlock) plus a
// captured body object's re-emitted OOXML subtree (#300/#517, ADR-072
// decision 1).
type SectionChild = Paragraph | SdtBlock | ImportedObjectBlock;

function emitNode(node: SpecNode, out: SectionChild[], ctx: SectionContext): boolean {
  const text = formatSectionReferences(node.text, ctx.format);
  if (node.type === 'note') {
    out.push(wrapWithControl(simpleParagraph(text, node.meta.pageBreakBefore), node.id));
    return true;
  }
  if (node.meta.vanish) return false;
  if (node.type === 'object') {
    if (!node.meta.object) {
      throw new GeneratorError(`object node ${node.id} is missing its captured blob (meta.object)`);
    }
    out.push(buildObjectBlocks(node.id, node.meta.object.blob));
    // A captured object's interior text reaches the document exclusively
    // through its re-emitted blob — its `objectText` children (#300, ADR-072
    // decision 2) exist only to carry editable text/merge metadata, never to
    // be independently walked and emitted as their own paragraphs.
    return false;
  }
  if (node.type === 'continuation') {
    out.push(wrapWithControl(simpleParagraph(text, node.meta.pageBreakBefore), node.id));
    return true;
  }
  // 'spec' is a root-container type; never appears as a paragraph node in tree.parts.
  // All unknown types fall through: getNodeLevel returns null, no paragraph emitted.
  const level = getNodeLevel(node.type);
  if (level !== null) {
    const para = numberedParagraph(
      text,
      level,
      ctx.reference,
      ctx.rules?.get(node.type),
      node.meta.pageBreakBefore
    );
    out.push(wrapWithControl(para, node.id));
  }
  return true;
}

function collectParagraphs(
  nodes: readonly SpecNode[],
  out: SectionChild[],
  ctx: SectionContext
): void {
  for (const node of nodes) {
    if (emitNode(node, out, ctx)) collectParagraphs(node.children, out, ctx);
  }
}

// Build one section's paragraph list: synthetic title (no anchor) + anchored body.
function buildSectionChildren(tree: SpecTree, ctx: SectionContext): SectionChild[] {
  const children: SectionChild[] = [
    titleParagraph(
      `SECTION ${displaySectionNumber(tree.section, ctx.format)} — ${tree.title}`,
      ctx.rules
    ),
  ];
  collectParagraphs(tree.parts, children, ctx);
  return children;
}

// Resolves `options.headerFooter` (#303) into a HeaderFooterRenderResult, or
// undefined when the caller didn't ask for one — the single gate that keeps
// generateDocx's output byte-identical to the pre-#303 baseline when the
// option is omitted. `sectionNumber`/`sectionTitle` are sourced only from
// `tree` (via the same `format` the body uses), never from the caller's
// field-value config, so a generated header/footer can't drift from the
// section it's attached to.
function renderOptionalHeaderFooter(
  tree: SpecTree,
  format: SectionNumberFormat,
  options: GenerateDocxOptions | undefined
): HeaderFooterRenderResult | undefined {
  if (options?.headerFooter === undefined) return undefined;
  const { composition, current, issuance } = options.headerFooter;
  const ctx: HeaderFooterFieldContext = {
    sectionNumber: displaySectionNumber(tree.section, format),
    sectionTitle: tree.title,
    current,
    ...(issuance !== undefined ? { issuance } : {}),
  };
  return renderHeaderFooterComposition(composition, ctx);
}

// Document()-level options driven by a header/footer render — currently just
// evenAndOddHeaderAndFooters, which docx models at the document (not
// section) level.
function documentLevelOptions(render: HeaderFooterRenderResult | undefined): {
  readonly evenAndOddHeaderAndFooters?: boolean;
} {
  return render?.evenAndOddHeaders ? { evenAndOddHeaderAndFooters: true } : {};
}

// #650 task 6/10: a `styles` block is only emitted when at least one
// captured object across `trees` actually referenced a vanish-resolved
// character style — the overwhelmingly common case has none, and this keeps
// that case's output byte-identical to before this fix (see
// object-vanish-styles.ts's own module comment for why this exists).
function vanishStylesOptions(trees: readonly SpecTree[]): { readonly styles?: IStylesOptions } {
  const ids = collectVanishCharacterStyleIds(trees);
  return ids.length > 0 ? { styles: { characterStyles: vanishCharacterStyleOptions(ids) } } : {};
}

// Section-level options driven by a header/footer render: docx's
// ISectionOptions carries `headers`/`footers` as siblings of `properties`,
// while titlePage/page-number-start/page-size live inside `properties` —
// this bundles all three so the call site can spread
// `{ ...sectionHeaderFooterOptions(render, pageSize), children }` without any
// conditional branching of its own. `properties.page.size` (#509) is always
// present — an absent `size` is exactly what triggers dolanmiu/docx's
// implicit A4 fallback, so every generated section must set it explicitly,
// independent of whether a header/footer was ever requested.
function sectionHeaderFooterOptions(
  render: HeaderFooterRenderResult | undefined,
  pageSize: PageSize
): {
  readonly headers?: NonNullable<HeaderFooterRenderResult['headers']>;
  readonly footers?: NonNullable<HeaderFooterRenderResult['footers']>;
  readonly properties: { readonly titlePage?: boolean; readonly page: PageSectionOption };
} {
  return {
    ...(render?.headers !== undefined ? { headers: render.headers } : {}),
    ...(render?.footers !== undefined ? { footers: render.footers } : {}),
    properties: {
      ...(render?.titlePage ? { titlePage: true } : {}),
      page: {
        size: toDocxPageSize(pageSize),
        ...(render?.pageNumberStart !== undefined
          ? { pageNumbers: { start: render.pageNumberStart } }
          : {}),
      },
    },
  };
}

interface PageSectionOption {
  readonly size: PageSizeOption;
  readonly pageNumbers?: { readonly start: number };
}

/**
 * Render the spec tree to DOCX. `styleRules` (from a style template, ADR-021)
 * applies per-NodeType font/spacing/indent to styled paragraphs and
 * numFmt/lvlText/start overrides to the numbering definition. Title, note,
 * and continuation paragraphs are not StyleNodeTypes and stay unstyled.
 * `options.headerFooter` (#303), when set, renders a resolved header/footer
 * composition onto the document's single section; omitted, output is
 * unchanged from the pre-#303 baseline.
 */
export async function generateDocx(
  tree: SpecTree,
  styleRules?: readonly StyleRule[],
  options?: GenerateDocxOptions
): Promise<Buffer> {
  try {
    const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
    const format = options?.sectionNumberFormat ?? 'canonical';
    const ctx = sectionContext(format, SPEC_NUM_REF, rules);
    const children = buildSectionChildren(tree, ctx);
    const render = renderOptionalHeaderFooter(tree, format, options);
    const pageSize = resolvePageSize(tree.pageSize);
    const doc = new Document({
      ...documentLevelOptions(render),
      ...vanishStylesOptions([tree]),
      numbering: { config: [buildSpecNumberingConfig(rules, SPEC_NUM_REF)] },
      sections: [{ ...sectionHeaderFooterOptions(render, pageSize), children }],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX generation failed', { cause: err });
  }
}

/**
 * Assemble an ordered list of section trees into a single project-manual DOCX
 * (ADR-017 D1). Each section gets its own OOXML section (a section break between
 * them) and its own numbering instance, so multilevel numbering restarts at
 * PART 1 in every section — the documented sharp edge (ADR-017 Consequences):
 * dolanmiu/docx numbering is document-scoped, so per-section restart requires a
 * distinct numbering reference (→ distinct abstractNum) per section. Every
 * paragraph keeps its `w:sdt` UUID anchor so a redlined manual can round-trip.
 *
 * The manual opens with a front-matter OOXML section — a cover page (project
 * `meta`, style-template applied) and a Word TOC field over the Heading1 section
 * titles (ADR-017 D1). Word computes the TOC entries + pagination on open; SpecR
 * emits the field + headings (structure), never page numbers.
 *
 * `options.headerFooter` (#481) renders the same composition into every spec
 * section — never the front-matter section, which is deliberately headerless
 * (confirmed empty of `headerReference`/`footerReference` for any composition,
 * cover pages carry no running header). Each spec's own `sectionNumber` /
 * `sectionTitle` still comes only from its own `SpecTree` (see
 * `renderOptionalHeaderFooter` below), so per-section renders can't drift or
 * collide with a sibling's.
 *
 * `evenAndOddHeaderAndFooters` is document-scoped in dolanmiu/docx, so it is
 * computed once from the first section's render and applied at the `Document`
 * level. This is not a shortcut — it is provably always correct: every
 * `renderOptionalHeaderFooter` call in the loop below shares the exact same
 * `options.headerFooter.composition` object reference (only `sectionNumber`/
 * `sectionTitle` vary per tree), so `composition.variants?.even !== undefined`
 * — the sole input to `evenAndOddHeaders` — is identical for every section.
 * There is no design-reachable state where per-section computation could
 * yield a different answer.
 *
 * `variants.first` (`titlePage`/`w:titlePg`) is likewise per-section: because
 * every `SpecTree` opens its own OOXML section, EVERY spec's own opening page
 * gets first-page header/footer treatment when the composition defines a
 * `first` variant — not just the whole manual's first page. This is intended
 * (each spec section behaves like its own mini-document for cover/first-page
 * purposes) but is easy to assume otherwise, so it is called out here
 * explicitly.
 */
export async function generateManual(
  trees: readonly SpecTree[],
  meta: ManualMeta,
  styleRules?: readonly StyleRule[],
  options?: GenerateDocxOptions
): Promise<Buffer> {
  if (trees.length === 0) {
    throw new GeneratorError('cannot generate a manual with no sections');
  }
  try {
    const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
    const format = options?.sectionNumberFormat ?? 'canonical';
    const frontMatter = buildFrontMatter(meta, styleRules);
    const sections = trees.map((tree, i) => {
      const reference = `${SPEC_NUM_REF}-${i}`;
      const render = renderOptionalHeaderFooter(tree, format, options);
      return {
        reference,
        ...sectionHeaderFooterOptions(render, resolvePageSize(tree.pageSize)),
        children: buildSectionChildren(tree, sectionContext(format, reference, rules)),
      };
    });
    const firstRender =
      trees[0] !== undefined ? renderOptionalHeaderFooter(trees[0], format, options) : undefined;
    // Front matter has no source SpecTree of its own — its page size (#509)
    // resolves from `trees[0]`, deliberately not `firstRender` (a
    // header/footer render, unrelated to page dimensions).
    const frontMatterPageSize = resolvePageSize(trees[0]?.pageSize);
    const doc = new Document({
      ...documentLevelOptions(firstRender),
      ...vanishStylesOptions(trees),
      numbering: { config: sections.map((s) => buildSpecNumberingConfig(rules, s.reference)) },
      sections: [
        {
          properties: { page: { size: toDocxPageSize(frontMatterPageSize) } },
          children: frontMatter,
        },
        ...sections,
      ],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX manual generation failed', { cause: err });
  }
}
