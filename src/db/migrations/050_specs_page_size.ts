import type { MigrationBuilder } from 'node-pg-migrate';

// #509 (ADR-075): persist the captured DOCX page size (`w:pgSz`) so it survives
// the upload → persistParsedSpec → getSpecTree → generateDocx round-trip. Before
// this column the parser captured `SpecTree.pageSize` in memory but persistence
// decomposed the tree into specs/paragraphs rows without it, so every A4/Legal/
// landscape source regenerated as Letter — the exact fidelity bug #509 exists to
// close. Stored as a nullable JSONB blob matching `PageSizeSchema`
// (`{ width, height, orientation? }`, twips); NULL === no explicit page size
// captured (a `.SEC` source, or a DOCX whose trailing `w:sectPr` lacks `w:pgSz`),
// which `resolvePageSize` maps back to the Letter default exactly as before.

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    page_size: { type: 'jsonb' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('specs', ['page_size']);
};
