import { Document, Paragraph, TextRun, Packer, HeadingLevel } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
import { buildFrontMatter, type ManualMeta } from './front-matter.js';
import type {
  SpecNode,
  SpecTree,
  StyleProperties,
  StyleRule,
  HeaderFooterComposition,
} from '../ast/index.js';
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

function noteParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function numberedParagraph(
  text: string,
  level: number,
  reference: string,
  props?: StyleProperties
): Paragraph {
  return new Paragraph({
    numbering: { reference, level },
    children: [new TextRun({ text, ...runStyleOptions(props?.rPr) })],
    ...paragraphStyleOptions(props?.pPr),
  });
}

function plainParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

// Section titles are Heading1 so the manual's Word TOC field (headingStyleRange
// '1-1') resolves exactly one entry per section. Harmless in single-section
// output, which carries no TOC.
function titleParagraph(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
}

function emitNode(node: SpecNode, out: (Paragraph | SdtBlock)[], ctx: SectionContext): boolean {
  const text = formatSectionReferences(node.text, ctx.format);
  if (node.type === 'note') {
    out.push(wrapWithControl(noteParagraph(text), node.id));
    return true;
  }
  if (node.meta.vanish) return false;
  if (node.type === 'continuation') {
    out.push(wrapWithControl(plainParagraph(text), node.id));
    return true;
  }
  // 'spec' is a root-container type; never appears as a paragraph node in tree.parts.
  // All unknown types fall through: getNodeLevel returns null, no paragraph emitted.
  const level = getNodeLevel(node.type);
  if (level !== null) {
    const para = numberedParagraph(text, level, ctx.reference, ctx.rules?.get(node.type));
    out.push(wrapWithControl(para, node.id));
  }
  return true;
}

function collectParagraphs(
  nodes: readonly SpecNode[],
  out: (Paragraph | SdtBlock)[],
  ctx: SectionContext
): void {
  for (const node of nodes) {
    if (emitNode(node, out, ctx)) collectParagraphs(node.children, out, ctx);
  }
}

// Build one section's paragraph list: synthetic title (no anchor) + anchored body.
function buildSectionChildren(tree: SpecTree, ctx: SectionContext): (Paragraph | SdtBlock)[] {
  const children: (Paragraph | SdtBlock)[] = [
    titleParagraph(`SECTION ${displaySectionNumber(tree.section, ctx.format)} — ${tree.title}`),
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

// Section-level options driven by a header/footer render: docx's
// ISectionOptions carries `headers`/`footers` as siblings of `properties`,
// while titlePage/page-number-start live inside `properties` — this bundles
// both so the call site can spread `{ ...sectionHeaderFooterOptions(render),
// children }` without any conditional branching of its own.
function sectionHeaderFooterOptions(render: HeaderFooterRenderResult | undefined): {
  readonly headers?: NonNullable<HeaderFooterRenderResult['headers']>;
  readonly footers?: NonNullable<HeaderFooterRenderResult['footers']>;
  readonly properties: { readonly titlePage?: boolean; readonly page?: PageNumberStartOption };
} {
  return {
    ...(render?.headers !== undefined ? { headers: render.headers } : {}),
    ...(render?.footers !== undefined ? { footers: render.footers } : {}),
    properties: {
      ...(render?.titlePage ? { titlePage: true } : {}),
      ...(render?.pageNumberStart !== undefined
        ? { page: { pageNumbers: { start: render.pageNumberStart } } }
        : {}),
    },
  };
}

interface PageNumberStartOption {
  readonly pageNumbers: { readonly start: number };
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
    const doc = new Document({
      ...documentLevelOptions(render),
      numbering: { config: [buildSpecNumberingConfig(rules, SPEC_NUM_REF)] },
      sections: [{ ...sectionHeaderFooterOptions(render), children }],
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
 * `options.headerFooter` (#303) is deliberately NOT wired here — the issue's
 * acceptance criteria describe header/footer rendering for standalone
 * generated specs (`generateDocx`), and a manual's own front-matter cover
 * page + per-section OOXML-section split need a header/footer story of their
 * own (running headers across sections, cover-page suppression) that's out
 * of scope for this PR.
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
      return {
        reference,
        children: buildSectionChildren(tree, sectionContext(format, reference, rules)),
      };
    });
    const doc = new Document({
      numbering: { config: sections.map((s) => buildSpecNumberingConfig(rules, s.reference)) },
      sections: [
        { properties: {}, children: frontMatter },
        ...sections.map((s) => ({ properties: {}, children: s.children })),
      ],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX manual generation failed', { cause: err });
  }
}
