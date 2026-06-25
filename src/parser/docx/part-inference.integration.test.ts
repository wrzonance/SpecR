import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';

// Real CPI-authored artifact whose PART headings are bare canonical names anchored
// on non-pStyle-linked numbering (ilvl=0 lvlText "PART %1 -"). Before the fix the
// Signal-1 guard demoted GENERAL/PRODUCTS to continuation and parseDocx reported a
// single part ("PART 3 - EXECUTION"). The file is gitignored manufacturer example
// data — present only in local dev, so the suite skips automatically in CI.
const ARTIFACT = resolve('docs/references/MANUFACTURER_EXAMPLES/parsing-needs-fixing.docx');

describe.runIf(existsSync(ARTIFACT))('CPI PART inference — parsing-needs-fixing.docx', () => {
  it('recovers exactly 3 part roots: GENERAL, PRODUCTS, EXECUTION (was 1)', async () => {
    const buffer = readFileSync(ARTIFACT);
    const tree = await parseDocx(buffer);

    const partRoots = tree.parts.filter((n) => n.type === 'part');
    expect(partRoots).toHaveLength(3);

    const joined = partRoots.map((n) => n.text).join(' | ');
    for (const name of ['GENERAL', 'PRODUCTS', 'EXECUTION']) {
      expect(joined).toContain(name);
    }
  });
});
