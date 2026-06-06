import type { MigrationBuilder } from 'node-pg-migrate';

// Expanded shape (ADR-020): NN NN NN | NN NN NN.NN | NN NN NN.NN NN
const SHAPE = String.raw`^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$`;

// NBSP→space, collapse whitespace runs, trim — SQL mirror of
// normalizeSectionNumber() in src/lib/section-number.ts.
const norm = (col: string): string =>
  `btrim(regexp_replace(replace(${col}, chr(160), ' '), '\\s+', ' ', 'g'))`;

export const up = (pgm: MigrationBuilder): void => {
  // Step 1: normalize existing rows. If two rows collapse to the same key,
  // the existing UNIQUE constraints (specs_section_source_unique,
  // csi_sections_section_number_key on spec_sections) abort this migration
  // loudly — by design; resolve duplicates manually before re-running.
  pgm.sql(`UPDATE specs SET section = ${norm('section')} WHERE section <> ${norm('section')}`);
  pgm.sql(
    `UPDATE spec_sections SET section_number = ${norm('section_number')} WHERE section_number <> ${norm('section_number')}`
  );

  // Step 2: shape gates. specs.section additionally admits the 'unknown'
  // sentinel written by the parse path for section-less documents.
  pgm.addConstraint('specs', 'specs_section_shape_check', {
    check: `section ~ '${SHAPE}' OR section = 'unknown'`,
  });
  pgm.addConstraint('spec_sections', 'spec_sections_section_number_shape_check', {
    check: `section_number ~ '${SHAPE}'`,
  });
  // Deliberately NO constraint on spec_references.target_spec_section: it
  // records what the source document said (descriptive, not canonical).
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('spec_sections', 'spec_sections_section_number_shape_check');
  pgm.dropConstraint('specs', 'specs_section_shape_check');
  // Whitespace normalization is lossy and is not reversed.
};
