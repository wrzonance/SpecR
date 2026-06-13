import { Document, Paragraph, TextRun, Packer } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
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

const SPEC_NUM_REF = 'spec-numbering' as const;

export interface GenerateDocxOptions {
  readonly sectionNumberFormat?: SectionNumberFormat;
}

function noteParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(`[NOTE] ${text}`)] });
}

function numberedParagraph(text: string, level: number, props?: StyleProperties): Paragraph {
  return new Paragraph({
    numbering: { reference: SPEC_NUM_REF, level },
    children: [new TextRun({ text, ...runStyleOptions(props?.rPr) })],
    ...paragraphStyleOptions(props?.pPr),
  });
}

function plainParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function displaySection(section: string, format: SectionNumberFormat): string {
  const canonical = normalizeSectionNumber(section);
  return canonical === null ? section : formatSectionNumber(canonical, format);
}

function emitNode(
  node: SpecNode,
  out: (Paragraph | SdtBlock)[],
  format: SectionNumberFormat,
  rules?: StyleRuleMap
): boolean {
  const text = formatSectionReferences(node.text, format);
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
    out.push(wrapWithControl(numberedParagraph(text, level, rules?.get(node.type)), node.id));
  }
  return true;
}

function collectParagraphs(
  nodes: readonly SpecNode[],
  out: (Paragraph | SdtBlock)[],
  format: SectionNumberFormat,
  rules?: StyleRuleMap
): void {
  for (const node of nodes) {
    if (emitNode(node, out, format, rules)) collectParagraphs(node.children, out, format, rules);
  }
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
    const sectionNumberFormat = options?.sectionNumberFormat ?? 'canonical';
    // Title paragraph is synthetic — no SpecNode.id, not a round-trip anchor
    const children: (Paragraph | SdtBlock)[] = [
      plainParagraph(
        `SECTION ${displaySection(tree.section, sectionNumberFormat)} — ${tree.title}`
      ),
    ];
    collectParagraphs(tree.parts, children, sectionNumberFormat, rules);
    const doc = new Document({
      numbering: { config: [buildSpecNumberingConfig(rules)] },
      sections: [{ properties: {}, children }],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX generation failed', { cause: err });
  }
}
