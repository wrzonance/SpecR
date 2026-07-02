import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';
import type { SpecNode } from '../../ast/types.js';

// Copyrighted manufacturer example — gitignored under docs/references/MANUFACTURER_*/*.docx,
// so this end-to-end test skips in CI and runs only where the file is present locally.
const FIXTURE = resolve('docs/references/MANUFACTURER_EXAMPLES/more-broken-parsing.docx');
const AVAILABLE = existsSync(FIXTURE);

// Regression (08 14 16 Flush Wood Doors): decorative "****** [OR] ******" separators
// kept the PART style (SPECText1 → ilvl 0) but set <w:numId w:val="0"/> to remove
// numbering. Signal 2 read the style's numbering and ignored the opt-out, promoting two
// separators into spurious PART nodes — splitting the standard 3-part spec into 5 and
// stealing FINISHES/ACCESSORIES from PRODUCTS and TOLERANCES.. from EXECUTION.
describe.skipIf(!AVAILABLE)(
  'more-broken-parsing.docx — [OR] separators are not parts (08 14 16)',
  () => {
    it('yields exactly the standard 3 parts GENERAL/PRODUCTS/EXECUTION', async () => {
      const { tree } = await parse(readFileSync(FIXTURE), 'more-broken-parsing.docx');

      const parts = tree.parts.filter((n) => n.type === 'part' && n.meta.vanish !== true);
      expect(parts.map((p) => p.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);
    });

    it('does not raise an unusual-part-count warning', async () => {
      const { tree } = await parse(readFileSync(FIXTURE), 'more-broken-parsing.docx');
      expect(tree.warnings?.some((w) => w.type === 'unusual-part-count')).not.toBe(true);
    });

    it('keeps PRODUCTS articles (FINISHES, ACCESSORIES) under PRODUCTS, not a spurious part', async () => {
      const { tree } = await parse(readFileSync(FIXTURE), 'more-broken-parsing.docx');
      const products = tree.parts.find((p) => p.type === 'part' && p.text === 'PRODUCTS');
      const articleTitles = (products?.children ?? [])
        .filter((c: SpecNode) => c.type === 'article')
        .map((c) => c.text);
      expect(articleTitles).toContain('FINISHES');
      expect(articleTitles).toContain('ACCESSORIES');
    });
  }
);
