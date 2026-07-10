import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';
import { renderMarkdown } from '../../generator/markdown.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';

// Copyrighted manufacturer example — gitignored under docs/references/MANUFACTURER_*/*.docx,
// so this end-to-end test skips in CI and runs only where the file is present locally.
const FIXTURE = resolve('docs/references/MANUFACTURER_EXAMPLES/more-parsing-examples-fails.docx');
const AVAILABLE = existsSync(FIXTURE);

async function parseFixture(): Promise<SpecTree> {
  const { tree } = await parse(readFileSync(FIXTURE), 'more-parsing-examples-fails.docx');
  return tree;
}

function findArticle(tree: SpecTree, name: string): SpecNode | undefined {
  for (const part of tree.parts) {
    for (const article of part.children) {
      if (article.type === 'article' && article.text === name) return article;
    }
  }
  return undefined;
}

const childTexts = (node: SpecNode | undefined, type: SpecNode['type']): string[] =>
  (node?.children ?? []).filter((c) => c.type === type).map((c) => c.text);

// #431: a Word/indent-numbered lead-in ("Abbreviations and Acronyms:") and its
// manual "1./2./…" sub-list collided at pr2, so the sub-list landed as siblings and
// the renderer double-labeled ("2. 1. Authority"). The lead-in-nesting pass promotes
// the lead-in to pr1 so the typed sub-list nests and its markers strip clean.
describe.skipIf(!AVAILABLE)(
  'more-parsing-examples-fails.docx — mixed-scheme lead-in nesting (#431)',
  () => {
    it('1.2 REFERENCES → A. Abbreviations with a nested {1..5} sub-list', async () => {
      const refs = findArticle(await parseFixture(), 'REFERENCES');
      const pr1 = childTexts(refs, 'pr1');
      expect(pr1).toContain('Abbreviations and Acronyms:');

      const abbrev = refs?.children.find((c) => c.text === 'Abbreviations and Acronyms:');
      expect(abbrev?.type).toBe('pr1');
      // Five typed items nest as pr2 children; their "1.".."5." markers are stripped.
      expect(childTexts(abbrev, 'pr2')).toEqual([
        'Authority having jurisdiction (AHJ)',
        'Ethylene-propylene rubber (EPR)',
        'National Electrical Code (NEC)',
        'National Fire Protection Association (NFPA)',
        'Underwriters Laboratories Inc. (UL)',
      ]);
    });

    it('1.2 REFERENCES → B. Definitions with a nested {1..2} sub-list', async () => {
      const refs = findArticle(await parseFixture(), 'REFERENCES');
      const definitions = refs?.children.find((c) => c.text === 'Definitions:');
      expect(definitions?.type).toBe('pr1');
      const items = childTexts(definitions, 'pr2');
      expect(items[0]).toBe(
        'NETA ATS: International Electrical Testing Association Acceptance Testing Specification.'
      );
      expect(items[1]).toBe('ICEA: Insulated Cable Engineers Association.');
    });

    it('1.2 REFERENCES has three peer lead-ins A./B./C. as direct children', async () => {
      const refs = findArticle(await parseFixture(), 'REFERENCES');
      // The author's structure (verified against Word) is three PEER lead-ins, all
      // direct children of the article — References Standards must NOT be vacuumed
      // under B. Definitions when A/B promote (don't-strand-peers rule).
      expect(childTexts(refs, 'pr1')).toEqual([
        'Abbreviations and Acronyms:',
        'Definitions:',
        'References Standards:',
      ]);
    });

    it('renders A./B./C. lead-ins with clean 1..n children — no double-label', async () => {
      const md = renderMarkdown(await parseFixture());
      expect(md).toMatch(/^A\. Abbreviations and Acronyms:$/m);
      expect(md).toMatch(/^ {3}1\. Authority having jurisdiction \(AHJ\)$/m);
      expect(md).toMatch(/^ {3}5\. Underwriters Laboratories Inc\. \(UL\)$/m);
      expect(md).toMatch(/^B\. Definitions:$/m);
      expect(md).toMatch(/^C\. References Standards:$/m);
      // The bug symptom was a "2. 1. Authority" double-label; the rendered line is now
      // exactly "1. Authority…" with no outer sibling number in front.
      const authorityLine = md.split('\n').find((l) => l.includes('Authority having jurisdiction'));
      expect(authorityLine?.trimStart()).toBe('1. Authority having jurisdiction (AHJ)');
    });

    // Regression pinned to the symptom (repo rule: name states the symptom).
    it('inference: mixed-scheme lead-in — Abbreviations pr1 owns typed 1..5 restart, not siblings', async () => {
      const refs = findArticle(await parseFixture(), 'REFERENCES');
      // The article's direct pr children are the two promoted lead-ins — NOT the ten
      // flat pr2 siblings (lead-ins + manual items) the collision produced before.
      const abbrev = refs?.children.find((c) => c.text === 'Abbreviations and Acronyms:');
      expect(abbrev?.children.filter((c) => c.type === 'pr2')).toHaveLength(5);
      // The first item's typed "1." is gone — proves nest + strip, not a raw sibling.
      expect(abbrev?.children[0]?.text.startsWith('1.')).toBe(false);
    });

    // References Standards' PLACEMENT is now correct: it is C., a direct child of the
    // article (peer of A/B). Only its SUBTREE remains a KNOWN AMBIGUITY (issue #436):
    // an editor typo "1 Cable:" (missing period) parses as a continuation instead of a
    // "1." restart, and the intentional category breakouts (Cable Sizing:/Splicing:/…)
    // land at pr4 depth. The pass promotes the peer lead-in without touching that
    // internal tangle — a correct fix for the subtree is deferred to #436.
    it('KNOWN AMBIGUITY (#436): References Standards is C. but its subtree stays tangled', async () => {
      const refs = findArticle(await parseFixture(), 'REFERENCES');
      const refStd = refs?.children.find((c) => c.text === 'References Standards:');
      expect(refStd?.type).toBe('pr1'); // placement fixed — peer of A/B
      // The messy internal structure is retained as-is, not resolved by this pass.
      expect(refStd?.children.some((c) => c.type === 'continuation' && c.text === '1 Cable:')).toBe(
        true
      );
    });
  }
);
