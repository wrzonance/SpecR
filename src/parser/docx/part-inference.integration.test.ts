import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';

// A real hand-authored artifact whose PART headings are bare canonical names anchored
// on non-pStyle-linked numbering (ilvl=0 lvlText "PART %1 -"). Before the fix the
// Signal-1 guard demoted GENERAL/PRODUCTS to continuation and parseDocx reported a
// single part ("PART 3 - EXECUTION"). The file is gitignored manufacturer example
// data — present only in local dev, so the suite skips automatically in CI.
const ARTIFACT = resolve('docs/references/MANUFACTURER_EXAMPLES/parsing-needs-fixing.docx');

describe.runIf(existsSync(ARTIFACT))(
  'numbering-lvlText PART inference — a hand-authored doc',
  () => {
    it('recovers exactly 3 part roots: GENERAL, PRODUCTS, EXECUTION (was 1)', async () => {
      const buffer = readFileSync(ARTIFACT);
      const tree = await parseDocx(buffer);

      const partRoots = tree.parts.filter((n) => n.type === 'part');
      expect(partRoots).toHaveLength(3);

      // Exact names, no baked-in "PART n -" prefix: PART 3's literal run text was
      // "PART 3 - EXECUTION"; the AST must store just "EXECUTION" so the renderer's
      // own label doesn't double it to "PART 3 - PART 3 - EXECUTION".
      expect(partRoots.map((n) => n.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);
    });
  }
);
