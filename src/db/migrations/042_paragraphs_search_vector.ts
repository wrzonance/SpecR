import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * #445 / ADR-062: full-text retrieval in core. Add a STORED generated `tsvector`
 * column derived from `paragraphs.text` (English config) plus a GIN index, so
 * ranked FTS (websearch_to_tsquery + ts_rank_cd + ts_headline) replaces the ILIKE
 * scan. Generated + STORED keeps the vector consistent with `text` with no trigger
 * and no application write path — the column cannot drift, and existing rows gain a
 * populated vector the moment this runs (no backfill/reparse). Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(
    `ALTER TABLE paragraphs
       ADD COLUMN search_vector tsvector
       GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED`
  );
  pgm.createIndex('paragraphs', 'search_vector', {
    name: 'paragraphs_search_vector_gin',
    method: 'gin',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('paragraphs', 'search_vector', { name: 'paragraphs_search_vector_gin' });
  pgm.dropColumns('paragraphs', ['search_vector']);
};
