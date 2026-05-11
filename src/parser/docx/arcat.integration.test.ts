import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import type { CsiNode } from '../../ast/types.js';

const ARCAT_DIR = resolve('docs/references/ARCAT');

function allNodes(nodes: readonly CsiNode[]): CsiNode[] {
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

describe('ARCAT fixture parsing', () => {
  for (const fixture of ARCAT_FIXTURES) {
    it(`${fixture}: parses with source=arcat`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      expect(tree.parts.length).toBeGreaterThan(0);
      // ARCAT files have preamble continuation nodes before CSI content;
      // source is set on all nodes from articleIlvl=1 detection.
      const nodes = allNodes(tree.parts);
      const sources = new Set(nodes.map((n) => n.meta.source));
      expect(sources.has('arcat')).toBe(true);
      expect(sources.has('cpi')).toBe(false);
    });

    it(`${fixture}: CSI hierarchy detected — has at least one non-continuation node`, async () => {
      const buffer = readFileSync(resolve(ARCAT_DIR, fixture));
      const tree = await parseDocx(buffer);

      const nodes = allNodes(tree.parts);
      const structured = nodes.filter(
        (n) => n.type === 'part' || n.type === 'article' || n.type === 'pr1'
      );
      // ARCAT files have structured CSI content (part/article/pr1) via numPr signal
      expect(structured.length).toBeGreaterThan(0);
    });
  }
});
