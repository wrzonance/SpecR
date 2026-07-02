import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import { parse } from '../index.js';
import type { SpecNode } from '../../ast/types.js';

const ARCAT_DIR = resolve('docs/references/ARCAT');
// These reference .docx files are copyrighted and gitignored — only present in local dev environments.
const FIXTURES_AVAILABLE = existsSync(resolve(ARCAT_DIR, '01_10_00arc.docx'));

function allNodes(nodes: readonly SpecNode[]): SpecNode[] {
  return [...nodes, ...nodes.flatMap((n) => allNodes(n.children))];
}

const ARCAT_FIXTURES = [
  '01_10_00arc.docx',
  '02_41_16arc.docx',
  '03_45_00dvp.docx',
  '04_21_00bbc.docx',
  '05_21_00vrc.docx',
  '05_31_13mil.docx',
  '06_05_73.13aww.docx',
  '06_13_00dlc.docx',
  '07_21_00ksp.docx',
  '07_40_00evr.docx',
  '08_71_00hco.docx',
  '09_21_16.23arc.docx',
  '10_14_00gem.docx',
  '10_26_41wci.docx',
  '11_12_00ame.docx',
  '11_12_33dki.docx',
  // '11_53_00nle.docx' — Git LFS stub, not a real DOCX in this repo
  '25_00_00dlt.docx',
  '26_09_33.docx',
  '28_13_53.11aic.docx',
  '28_23_00vii.docx',
  '33_05_97trt.docx',
  '40_13_00nfb.docx',
];

// Files are copyrighted and gitignored — tests skip automatically in CI.
describe.skipIf(!FIXTURES_AVAILABLE)('prefixed-heading-style corpus fixture parsing', () => {
  it('classifies standard article roles (REFERENCES at minimum)', async () => {
    // NOTE: 07_21_00ksp.docx is expected to contain a References article.
    // If CI reports "references not found", swap to another fixture from ARCAT_FIXTURES
    // that is confirmed to carry a REFERENCES heading.
    const buffer = readFileSync(resolve(ARCAT_DIR, '07_21_00ksp.docx'));
    const { tree } = await parse(buffer, '07_21_00ksp.docx');
    const roles = allNodes(tree.parts)
      .filter((n) => n.type === 'article')
      .map((n) => n.meta.articleRole)
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    // These sections reliably carry a References article; assert role tagging fired.
    expect(roles).toContain('references');
    // No non-article node should ever carry a role.
    const badlyTagged = allNodes(tree.parts).filter(
      (n) => n.type !== 'article' && n.meta.articleRole !== undefined
    );
    expect(badlyTagged).toEqual([]);
  });

  for (const fixture of ARCAT_FIXTURES) {
    it(`${fixture}: parses with source=arcat`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      expect(tree.parts.length).toBeGreaterThan(0);
      // These files have preamble continuation nodes before CSI content;
      // source is stamped on every node from the document-level style-vocabulary
      // fingerprint (detectSource), independent of node type or level.
      const nodes = allNodes(tree.parts);
      const sources = new Set(nodes.map((n) => n.meta.source));
      expect(sources.has('arcat')).toBe(true);
      expect(sources.has('cpi')).toBe(false);
    });

    // Regression: "PART n" prefixes are numbering-generated (lvlText
    // "PART %1"), so the literal-text part guard demoted every PART heading to
    // continuation — one fixture rendered 34 roots instead of 3 parts.
    it(`${fixture}: exactly 3 part-type roots (GENERAL/PRODUCTS/EXECUTION)`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      const partRoots = tree.parts.filter((n) => n.type === 'part');
      expect(partRoots).toHaveLength(3);
      // articles nest under parts, never at root
      expect(tree.parts.filter((n) => n.type === 'article')).toHaveLength(0);
    });

    it(`${fixture}: parse() infers section from content when core.xml is empty`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const { tree, sectionInference } = await parse(buffer, fixture);

      expect(sectionInference.method).toBe('content-high');
      expect(tree.section).toMatch(/^\d{2} \d{2} \d{2}(\.\d{2})?$/);
      expect(tree.title).not.toBe('unknown');
    });

    it(`${fixture}: specifier notes are vanish notes, preamble junk is warned`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      const notes = allNodes(tree.parts).filter((n) => n.type === 'note');
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.every((n) => n.meta.vanish === true)).toBe(true);
      // preamble (title/copyright lines) still lands at root — flagged loudly
      expect((tree.warnings ?? []).some((w) => w.type === 'root-continuation')).toBe(true);
    });
  }
});
