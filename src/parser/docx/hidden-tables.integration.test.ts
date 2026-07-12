import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';

// Copyrighted manufacturer example — gitignored under docs/references/MANUFACTURER_*/*.docx,
// so this end-to-end test skips in CI and runs only where the file is present locally.
const FIXTURE = resolve('docs/references/MANUFACTURER_EXAMPLES/hidden-text-test.docx');
const AVAILABLE = existsSync(FIXTURE);

// #293: hidden-text-test.docx carries 4 tables — 3 sign-off/revision-history tables
// authored fully hidden (every text-bearing cell paragraph vanish) and 1 visible
// submittal table. Hidden tables are retained out-of-band (ADR-038, INV-1); the
// visible table is counted only and surfaced as a table-content-skipped warning
// (INV-6). Retained rows preserve real cell text, never blank placeholders (INV-7).
describe.skipIf(!AVAILABLE)('hidden-tables.docx — retain hidden, warn on visible (#293)', () => {
  it('retains exactly 3 hidden tables with non-empty rows and warns on the visible one', async () => {
    const { tree } = await parse(readFileSync(FIXTURE), 'hidden-text-test.docx');

    // INV-1: hidden tables are retained out-of-band, one entry per hidden w:tbl.
    expect(tree.hiddenTables, 'hiddenTables key absent').toBeDefined();
    expect(tree.hiddenTables).toHaveLength(3);

    // INV-7: retained rows carry real cell text — never an all-blank grid.
    for (const table of tree.hiddenTables ?? []) {
      expect(table.rows.length).toBeGreaterThan(0);
      const hasNonBlankCell = table.rows.some((row) => row.some((c) => c.trim().length > 0));
      expect(
        hasNonBlankCell,
        `retained table has no non-blank cell: ${JSON.stringify(table)}`
      ).toBe(true);
    }

    // INV-6: the one visible table is counted, not modeled, and surfaced as a warning.
    const tableWarnings = (tree.warnings ?? []).filter((w) => w.type === 'table-content-skipped');
    expect(tableWarnings.length).toBeGreaterThanOrEqual(1);
  });
});
