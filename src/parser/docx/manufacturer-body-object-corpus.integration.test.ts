// Corpus-gated companion to body-object-round-trip.test.ts (#517, WS2 task
// 5/7): the unit suite proves the parse -> generate -> re-parse cycle on
// hand-authored minimal fixtures; this proves the same generator boundary
// against a REAL manufacturer-authored table (a revision-history block
// carrying a "Description of Change" header cell) that motivated the #517
// fix in the first place.
//
// Copyrighted manufacturer example — gitignored under
// docs/references/MANUFACTURER_*/*.docx, so this end-to-end test skips in CI
// and runs only where the file is present locally (mirrors
// paring-fixes.integration.test.ts's own skipIf pattern).

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { parse } from '../index.js';
import { generateDocx } from '../../generator/index.js';

const FIXTURE = resolve('docs/references/MANUFACTURER_EXAMPLES/parsing-needs-fixing.docx');
const AVAILABLE = existsSync(FIXTURE);

describe.skipIf(!AVAILABLE)(
  'parsing-needs-fixing.docx — captured body-object regeneration (#517)',
  () => {
    it('regenerates a real <w:tbl> containing "Description of Change" from its captured body object', async () => {
      const { tree } = await parse(readFileSync(FIXTURE), 'parsing-needs-fixing.docx');

      const buffer = await generateDocx(tree);
      const zip = await JSZip.loadAsync(buffer);
      const file = zip.file('word/document.xml');
      if (!file) throw new Error('word/document.xml not found in regenerated DOCX');
      const xml = await file.async('string');

      // The source table this fixture carries a revision-history block whose
      // header row reads "Description of Change" — proving the re-emitted blob
      // is a REAL <w:tbl>, not some other captured shape that merely happens
      // to carry the same text.
      expect(xml).toContain('<w:tbl>');
      // Exactly ONCE, not merely "present": the #517 defect this fixture
      // motivated re-emitted the object's own text a SECOND time via a
      // regressed objectText paragraph alongside the object's captured blob
      // — `toContain` alone can't tell that duplication apart from a single,
      // correct occurrence. Counting occurrences is what actually catches a
      // reintroduction of that duplication on real-world data.
      const occurrences = xml.split('Description of Change').length - 1;
      expect(occurrences).toBe(1);
    });
  }
);
