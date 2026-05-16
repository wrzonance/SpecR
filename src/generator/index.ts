import { Document, Paragraph, TextRun, Packer } from 'docx';
import { wrapWithControl, SdtBlock } from './controls.js';
import type { CsiNode, CsiTree } from '../ast/types.js';
import { GeneratorError } from './error.js';
import { buildCsiNumberingConfig, getNodeLevel } from './numbering.js';

const CSI_NUM_REF = 'csi-numbering' as const;

function noteParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(`[NOTE] ${text}`)] });
}

function numberedParagraph(text: string, level: number): Paragraph {
  return new Paragraph({
    numbering: { reference: CSI_NUM_REF, level },
    children: [new TextRun(text)],
  });
}

function plainParagraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function emitNode(node: CsiNode, out: (Paragraph | SdtBlock)[]): boolean {
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
  if (level !== null) out.push(wrapWithControl(numberedParagraph(node.text, level), node.id));
  return true;
}

function collectParagraphs(nodes: readonly CsiNode[], out: (Paragraph | SdtBlock)[]): void {
  for (const node of nodes) {
    if (emitNode(node, out)) collectParagraphs(node.children, out);
  }
}

export async function generateDocx(tree: CsiTree): Promise<Buffer> {
  try {
    // Title paragraph is synthetic — no CsiNode.id, not a round-trip anchor
    const children: (Paragraph | SdtBlock)[] = [
      plainParagraph(`SECTION ${tree.section} — ${tree.title}`),
    ];
    collectParagraphs(tree.parts, children);
    const doc = new Document({
      numbering: { config: [buildCsiNumberingConfig()] },
      sections: [{ properties: {}, children }],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('DOCX generation failed', { cause: err });
  }
}
