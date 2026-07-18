import type { SpecTree } from '../ast/index.js';
import {
  getCurrentParagraphSnapshots,
  getObjectStructuralSnapshots,
  getParagraphSnapshots,
  getSpecTree,
} from '../db/index.js';
import { formatSectionNumber, normalizeSectionNumber } from '../lib/section-number.js';
import { computeDiff } from './diff.js';
import { extractContentControls } from './extract.js';
import type { DiffResult, ExtractResult } from './types.js';

function generatedTitleText(tree: SpecTree): string {
  const canonical = normalizeSectionNumber(tree.section);
  const section = canonical === null ? tree.section : formatSectionNumber(canonical, 'canonical');
  return `SECTION ${section} — ${tree.title}`;
}

function withoutGeneratedTitle(theirs: ExtractResult, tree: SpecTree): ExtractResult {
  const generated = generatedTitleText(tree);
  let removed = false;
  return {
    ...theirs,
    orphans: theirs.orphans.filter((orphan) => {
      if (!removed && orphan.text === generated) {
        removed = true;
        return false;
      }
      return true;
    }),
  };
}

export async function computeSpecDiff(
  specId: string,
  docxBuffer: Buffer
): Promise<DiffResult | null> {
  const spec = await getSpecTree(specId);
  if (!spec) return null;
  const [base, ours, theirs, objectSnapshots] = await Promise.all([
    getParagraphSnapshots(specId),
    getCurrentParagraphSnapshots(specId),
    extractContentControls(docxBuffer),
    getObjectStructuralSnapshots(specId),
  ]);
  return computeDiff(base, ours, withoutGeneratedTitle(theirs, spec.tree), objectSnapshots);
}
