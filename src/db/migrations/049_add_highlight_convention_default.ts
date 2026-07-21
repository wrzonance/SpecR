import type { MigrationBuilder } from 'node-pg-migrate';

const DEFAULT_HIGHLIGHT_MEANINGS = '[{"color":"yellow","meaning":"choice"}]';

/** Add the draft-marker default only to the read-only built-in profile. */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    UPDATE editing_conventions
    SET rules = jsonb_set(
      rules,
      '{highlightMeanings}',
      '${DEFAULT_HIGHLIGHT_MEANINGS}'::jsonb,
      true
    ), updated_at = now()
    WHERE library_id IS NULL AND NOT (rules ? 'highlightMeanings')
  `);
};

/** Remove only the exact default installed above; preserve administrator data. */
export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    UPDATE editing_conventions
    SET rules = rules - 'highlightMeanings', updated_at = now()
    WHERE library_id IS NULL
      AND rules -> 'highlightMeanings' = '${DEFAULT_HIGHLIGHT_MEANINGS}'::jsonb
  `);
};
