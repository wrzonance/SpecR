import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import type { CsiNode } from '../../ast/types.js';

const CPI_DIR = resolve('docs/references/MANUFACTURER_CPI');

function allNodes(nodes: readonly CsiNode[]): CsiNode[] {
  return [...nodes, ...nodes.flatMap((n) => allNodes(n.children))];
}

const CPI_FIXTURES = [
  'CPI_BUSBAR_CSIMFS.docx',
  'CPI_CABLE_MANAGEMENT_AND_LADDER_RACKS_CSIMFS.docx',
  'CPI_COMMUNICATIONS_CABINETS_RACKS_FRAMES_ENCLOSURES_CSIMFS.docx',
  'CPI_COMMUNICATIONS_RACK_MOUNTED_POWER_PROTECTION_CSIMFS.docx',
  'CPI_DATA_COMMUNICATIONS_WIRELESS_ACCESS_POINTS_CSIMFS.docx',
  'CPI_ELECTRICAL_CABINETS_AND_ENCLOSURES_CSIMFS.docx',
];

describe('CPI fixture parsing', () => {
  for (const fixture of CPI_FIXTURES) {
    it(`${fixture}: parses with source=cpi`, async () => {
      const buffer = readFileSync(resolve(CPI_DIR, fixture));
      const tree = await parseDocx(buffer);

      expect(tree.parts.length).toBeGreaterThan(0);
      const nodes = allNodes(tree.parts);
      const sources = new Set(nodes.map((n) => n.meta.source));
      expect(sources.has('cpi')).toBe(true);
    });

    it(`${fixture}: has continuation nodes (PR1lc suppression working)`, async () => {
      // KNOWN AMBIGUITY: We cannot assert zero 'pr1' nodes — some pr1 paragraphs are valid.
      // We assert that continuation nodes exist, proving numId=0 suppression detection works.
      const buffer = readFileSync(resolve(CPI_DIR, fixture));
      const tree = await parseDocx(buffer);

      const nodes = allNodes(tree.parts);
      const continuations = nodes.filter((n) => n.type === 'continuation');
      expect(continuations.length).toBeGreaterThan(0);
    });

    it(`${fixture}: has CSI hierarchy (part, article nodes present)`, async () => {
      const buffer = readFileSync(resolve(CPI_DIR, fixture));
      const tree = await parseDocx(buffer);

      const nodes = allNodes(tree.parts);
      const hasPart = nodes.some((n) => n.type === 'part');
      const hasArticle = nodes.some((n) => n.type === 'article');
      expect(hasPart).toBe(true);
      expect(hasArticle).toBe(true);
    });
  }

  it('inference: CPI numId=0 continuation — PR1lc not classified as pr1', async () => {
    // Regression: PR1lc style has numId=0 (suppressesNumbering=true).
    // Previously resolveNumPrChain walked past suppression → misclassified as pr1.
    // Fix: Clippit ListItemRetriever pattern stops basedOn chain at numId=0.
    // Proxy assertion: continuation count > pr1 count (CPI files have many continuation
    // paragraphs from lc-suffixed styles; if suppression broken, they'd all be pr1).
    const buffer = readFileSync(resolve(CPI_DIR, 'CPI_BUSBAR_CSIMFS.docx'));
    const tree = await parseDocx(buffer);

    const nodes = allNodes(tree.parts);
    const continuations = nodes.filter((n) => n.type === 'continuation').length;
    const pr1s = nodes.filter((n) => n.type === 'pr1').length;
    // In a correctly-parsed CPI file, continuation paragraphs significantly outnumber pr1
    expect(continuations).toBeGreaterThan(pr1s);
  });
});
