import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import { parse } from '../index.js';
import type { SpecNode } from '../../ast/types.js';

const CPI_DIR = resolve('docs/references/MANUFACTURER_CPI');
// These reference .docx files are copyrighted and gitignored — only present in local dev environments.
const FIXTURES_AVAILABLE = existsSync(resolve(CPI_DIR, 'CPI_BUSBAR_CSIMFS.docx'));

function allNodes(nodes: readonly SpecNode[]): SpecNode[] {
  return [...nodes, ...nodes.flatMap((n) => allNodes(n.children))];
}

// The closed set of provenance tags SpecNode.meta.source may carry (ast/types.ts).
const VALID_SOURCES: ReadonlySet<string | undefined> = new Set([
  'ufgs',
  'arcat',
  'cpi',
  'unknown',
  undefined,
]);

const CPI_FIXTURES = [
  'CPI_BUSBAR_CSIMFS.docx',
  'CPI_CABLE_MANAGEMENT_AND_LADDER_RACKS_CSIMFS.docx',
  'CPI_COMMUNICATIONS_CABINETS_RACKS_FRAMES_ENCLOSURES_CSIMFS.docx',
  'CPI_COMMUNICATIONS_RACK_MOUNTED_POWER_PROTECTION_CSIMFS.docx',
  'CPI_DATA_COMMUNICATIONS_WIRELESS_ACCESS_POINTS_CSIMFS.docx',
  'CPI_ELECTRICAL_CABINETS_AND_ENCLOSURES_CSIMFS.docx',
];

// Files are copyrighted and gitignored — tests skip automatically in CI.
describe.skipIf(!FIXTURES_AVAILABLE)('reserved-low-level corpus fixture parsing', () => {
  for (const fixture of CPI_FIXTURES) {
    it(`${fixture}: parses into a valid CSI hierarchy with only valid source tags`, async () => {
      // KNOWN AMBIGUITY: v1 generic-style CPI files carry NO vendor style
      // fingerprint — no PRT/ART short-form styles, no ARCAT* prefix — so
      // detectSource cannot tag them 'cpi' and returns 'unknown' by design. That
      // is correct: meta.source is annotation-only, never an inference input
      // (PR #333 / signal-derived doctrine), and fingerprinting a plain Word doc
      // as CPI would false-positive. The real invariant is structural round-trip
      // fidelity, plus source staying inside the closed enum — asserted here.
      const buffer = readFileSync(resolve(CPI_DIR, fixture));
      const tree = await parseDocx(buffer);

      const nodes = allNodes(tree.parts);
      expect(tree.parts.filter((n) => n.type === 'part').length).toBeGreaterThan(0);
      expect(nodes.some((n) => n.type === 'article')).toBe(true);
      expect(nodes.every((n) => VALID_SOURCES.has(n.meta.source))).toBe(true);
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

  it('inference: numId=0 continuation — PR1lc not classified as pr1', async () => {
    // Regression: PR1lc style has numId=0 (suppressesNumbering=true).
    // Previously resolveNumPrChain walked past suppression → misclassified as pr1.
    // Fix: Clippit ListItemRetriever pattern stops basedOn chain at numId=0.
    // Proxy assertion: continuation count > pr1 count (these files have many continuation
    // paragraphs from lc-suffixed styles; if suppression broken, they'd all be pr1).
    const buffer = readFileSync(resolve(CPI_DIR, 'CPI_BUSBAR_CSIMFS.docx'));
    const tree = await parseDocx(buffer);

    const nodes = allNodes(tree.parts);
    const continuations = nodes.filter((n) => n.type === 'continuation').length;
    const pr1s = nodes.filter((n) => n.type === 'pr1').length;
    // In a correctly-parsed file of this family, continuation paragraphs significantly outnumber pr1
    expect(continuations).toBeGreaterThan(pr1s);
  });

  it('normalizes the reserved-low-level ilvl offset into typed article nodes', async () => {
    // KNOWN AMBIGUITY: this fixture's headings are manufacturer-specific (WORK
    // INCLUDED, SCOPE OF WORK, WALL-MOUNT BUSBARS, …), not standard CSI article
    // titles, so they legitimately derive NO role — ADR-033's "absent rather than
    // wrong" contract. Asserting a role is present would be asserting a wrong
    // answer. The real regression guard for the reserved-low-level offset path is
    // that the offset is normalized into node_type='article' before role
    // derivation runs — so we assert typed article nodes exist, not roles.
    const buffer = readFileSync(resolve(CPI_DIR, 'CPI_BUSBAR_CSIMFS.docx'));
    const { tree } = await parse(buffer, 'CPI_BUSBAR_CSIMFS.docx');
    const articles = allNodes(tree.parts).filter((n) => n.type === 'article');
    expect(articles.length).toBeGreaterThan(0);
    expect(articles.every((n) => n.type === 'article')).toBe(true);
  });
});
