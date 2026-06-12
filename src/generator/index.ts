import { Document, Paragraph, TextRun, Packer } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
import type { SpecNode, SpecTree, StyleProperties, StyleRule } from '../ast/index.js';
import { GeneratorError } from './error.js';
import { buildSpecNumberingConfig, getNodeLevel } from './numbering.js';
import { buildRuleMap, paragraphStyleOptions, runStyleOptions } from './styles.js';
import type { StyleRuleMap } from './styles.js';

const SPEC_NUM_REF = 'spec-numbering' as const;

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

function emitNode(node: SpecNode, out: (Paragraph | SdtBlock)[], rules?: StyleRuleMap): boolean {
  if (node.type === 'note') {
    out.push(wrapWithControl(noteParagraph(node.text), node.id));
    return true;
  }
  if (node.meta.vanish) return false;
  if (node.type === 'continuation') {
    out.push(wrapWithControl(plainParagraph(node.text), node.id));
    return true;
  }
  // 'spec' is a root-container type; never appears as a paragraph node in tree.parts.
  // All unknown types fall through: getNodeLevel returns null, no paragraph emitted.
  const level = getNodeLevel(node.type);
  if (level !== null) {
    out.push(wrapWithControl(numberedParagraph(node.text, level, rules?.get(node.type)), node.id));
  }
  return true;
}

function collectParagraphs(
  nodes: readonly SpecNode[],
  out: (Paragraph | SdtBlock)[],
  rules?: StyleRuleMap
): void {
  for (const node of nodes) {
    if (emitNode(node, out, rules)) collectParagraphs(node.children, out, rules);
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
  styleRules?: readonly StyleRule[]
): Promise<Buffer> {
  try {
    const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
    // Title paragraph is synthetic — no SpecNode.id, not a round-trip anchor
    const children: (Paragraph | SdtBlock)[] = [
      plainParagraph(`SECTION ${tree.section} — ${tree.title}`),
    ];
    collectParagraphs(tree.parts, children, rules);
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
