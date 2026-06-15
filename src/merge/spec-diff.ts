import type { SpecTree } from '../ast/index.js';
import { getCurrentParagraphSnapshots, getParagraphSnapshots, getSpecTree } from '../db/index.js';
import { formatSectionNumber, normalizeSectionNumber } from '../lib/section-number.js';
import { computeDiff } from './diff.js';
import { extractContentControls } from './extract.js';
import type { DiffResult, ExtractResult } from './types.js';

function generatedTitleText(tree: SpecTree): string {
  const canonical = normalizeSectionNumber(tree.section);
  const section = canonical === null ? tree.section : formatSectionNumber(canonical, 'canonical');
  return `SECTION ${section} — ${tree.title}`;
}

function isGeneratedTitleOrphan(
  orphan: { readonly text: string; readonly index: number },
  tree: SpecTree
): boolean {
  return orphan.index === 0 && orphan.text === generatedTitleText(tree);
}

function withoutGeneratedTitle(theirs: ExtractResult, tree: SpecTree): ExtractResult {
  return {
    ...theirs,
    orphans: theirs.orphans.filter((orphan) => !isGeneratedTitleOrphan(orphan, tree)),
  };
}

export async function computeSpecDiff(
  specId: string,
  docxBuffer: Buffer
): Promise<DiffResult | null> {
  const spec = await getSpecTree(specId);
  if (!spec) return null;
  const [base, ours, theirs] = await Promise.all([
    getParagraphSnapshots(specId),
    getCurrentParagraphSnapshots(specId),
    extractContentControls(docxBuffer),
  ]);
  return computeDiff(base, ours, withoutGeneratedTitle(theirs, spec.tree));
}
