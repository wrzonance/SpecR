import { Document, Paragraph, TextRun, Packer, HeadingLevel } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
import { buildFrontMatter, type ManualMeta } from './front-matter.js';
import type { SpecNode, SpecTree, StyleProperties, StyleRule } from '../ast/index.js';
import { GeneratorError } from './error.js';
import { buildSpecNumberingConfig, getNodeLevel } from './numbering.js';
import { buildRuleMap, paragraphStyleOptions, runStyleOptions } from './styles.js';
import type { StyleRuleMap } from './styles.js';
import {
  formatSectionNumber,
  formatSectionReferences,
  normalizeSectionNumber,
  type SectionNumberFormat,
} from '../lib/section-number.js';

export { generateSec } from './sec/index.js';

const SPEC_NUM_REF = 'spec-numbering' as const;

export interface GenerateDocxOptions {
  readonly sectionNumberFormat?: SectionNumberFormat;
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

function displaySection(section: string, format: SectionNumberFormat): string {
  const canonical = normalizeSectionNumber(section);
  return canonical === null ? section : formatSectionNumber(canonical, format);
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
    titleParagraph(`SECTION ${displaySection(tree.section, ctx.format)} — ${tree.title}`),
  ];
  collectParagraphs(tree.parts, children, ctx);
  return children;
}

/**
 * Render the spec tree to DOCX. `styleRules` (from a style template, ADR-021)
 * applies per-NodeType font/spacing/indent to styled paragraphs and
 * numFmt/lvlText/start overrides to the numbering definition. Title, note,
 * and continuation paragraphs are not StyleNodeTypes and stay unstyled.
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
    const doc = new Document({
      numbering: { config: [buildSpecNumberingConfig(rules, SPEC_NUM_REF)] },
      sections: [{ properties: {}, children }],
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
