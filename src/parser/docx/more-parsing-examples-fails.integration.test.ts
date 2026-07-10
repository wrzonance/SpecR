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

    it('renders A./B. lead-ins with clean 1..n children — no double-label', async () => {
      const md = renderMarkdown(await parseFixture());
      expect(md).toMatch(/^A\. Abbreviations and Acronyms:$/m);
      expect(md).toMatch(/^ {3}1\. Authority having jurisdiction \(AHJ\)$/m);
      expect(md).toMatch(/^ {3}5\. Underwriters Laboratories Inc\. \(UL\)$/m);
      expect(md).toMatch(/^B\. Definitions:$/m);
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

    // KNOWN AMBIGUITY: the "References Standards:" subtree is a different mixed-scheme
    // tangle (a stray "1 Cable:" parsed as a continuation, pr4 depth) whose following
    // run is NOT a Signal-4 restart, so the pass does not promote it. Once Definitions
    // is promoted to pr1, "References Standards:" (still pr2) nests under Definitions
    // rather than remaining a REFERENCES-level peer. Pinning current behavior — a
    // correct fix for this subtree is out of scope for #431.
    it('KNOWN AMBIGUITY: References Standards subtree nests under Definitions, not promoted', async () => {
      const refs = findArticle(await parseFixture(), 'REFERENCES');
      const definitions = refs?.children.find((c) => c.text === 'Definitions:');
      const refStd = definitions?.children.find((c) => c.text === 'References Standards:');
      expect(refStd?.type).toBe('pr2');
      // It keeps its own (messy) subtree — it was not flattened or promoted.
      expect(refStd?.children.length ?? 0).toBeGreaterThan(0);
    });
  }
);
