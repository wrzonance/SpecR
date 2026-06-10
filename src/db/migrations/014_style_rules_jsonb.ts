import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ADR-021: replace the scalar style columns on style_rules with one OOXML-faithful
 * JSONB `properties` payload. Backfill from the old columns, enrich UFGS-Default with
 * the line spacing the old schema could not hold (migration 011 documented line=360),
 * then drop the scalar columns. Reversible.
 */

// Backfill: map scalar columns → JSONB. jsonb_strip_nulls removes null-valued keys.
const SQL_BACKFILL = `
  UPDATE style_rules SET properties = jsonb_strip_nulls(jsonb_build_object(
    'rPr', NULLIF(jsonb_strip_nulls(jsonb_build_object(
      'rFonts', CASE WHEN font_family IS NULL THEN NULL
                     ELSE jsonb_build_object('ascii', font_family) END,
      'sz', font_size_half_pt,
      'b', CASE WHEN bold THEN true ELSE NULL END,
      'caps', CASE WHEN caps THEN true ELSE NULL END
    )), '{}'::jsonb),
    'pPr', NULLIF(jsonb_strip_nulls(jsonb_build_object(
      'spacing', NULLIF(jsonb_strip_nulls(jsonb_build_object(
        'before', space_before_twips,
        'after', space_after_twips
      )), '{}'::jsonb),
      'ind', NULLIF(jsonb_strip_nulls(jsonb_build_object('left', indent_twips)), '{}'::jsonb)
    )), '{}'::jsonb),
    'numbering', NULLIF(jsonb_strip_nulls(jsonb_build_object('lvlText', numbering_format)), '{}'::jsonb)
  ))
`;

// Enrich UFGS-Default: SpecNormal line spacing (pr1–pr5 only; migration 011 comment).
const SQL_ENRICH_LINE = `
  UPDATE style_rules sr SET properties = jsonb_set(
    jsonb_set(sr.properties, '{pPr,spacing,line}', '360'::jsonb, true),
    '{pPr,spacing,lineRule}', '"auto"'::jsonb, true
  )
  FROM style_templates st
  WHERE sr.template_id = st.id AND st.name = 'UFGS-Default'
    AND sr.node_type IN ('pr1','pr2','pr3','pr4','pr5')
`;

// Enrich UFGS-Default: numFmt + ilvl per level (matches generator buildSpecNumberingConfig).
const SQL_ENRICH_NUMFMT = `
  UPDATE style_rules sr SET properties = jsonb_set(
    sr.properties, '{numbering}',
    COALESCE(sr.properties->'numbering', '{}'::jsonb)
      || jsonb_build_object('numFmt', v.fmt, 'ilvl', v.ilvl),
    true
  )
  FROM style_templates st, (VALUES
    ('part','decimal',0),('article','decimal',1),('pr1','upperLetter',2),
    ('pr2','decimal',3),('pr3','lowerLetter',4),('pr4','decimal',5),('pr5','lowerLetter',6)
  ) AS v(node_type, fmt, ilvl)
  WHERE sr.template_id = st.id AND st.name = 'UFGS-Default' AND sr.node_type = v.node_type
`;

// Back-projection: JSONB → scalar columns (best-effort; enrichment-only values dropped).
// The JSONB schema is sign-permissive (ADR-021), but the restored scalar columns carry
// a non-negative CHECK, so any negative value is mapped to NULL — the old schema has no
// representation for it. This keeps up → write(negative) → down reversible.
const SQL_BACK_PROJECT = `
  UPDATE style_rules SET
    font_family        = properties #>> '{rPr,rFonts,ascii}',
    font_size_half_pt  = CASE WHEN (properties #>> '{rPr,sz}')::int >= 0
                              THEN (properties #>> '{rPr,sz}')::int END,
    bold               = COALESCE((properties #>> '{rPr,b}')::boolean, false),
    caps               = COALESCE((properties #>> '{rPr,caps}')::boolean, false),
    indent_twips       = CASE WHEN (properties #>> '{pPr,ind,left}')::int >= 0
                              THEN (properties #>> '{pPr,ind,left}')::int END,
    space_before_twips = CASE WHEN (properties #>> '{pPr,spacing,before}')::int >= 0
                              THEN (properties #>> '{pPr,spacing,before}')::int END,
    space_after_twips  = CASE WHEN (properties #>> '{pPr,spacing,after}')::int >= 0
                              THEN (properties #>> '{pPr,spacing,after}')::int END,
    numbering_format   = properties #>> '{numbering,lvlText}'
`;

const SCALAR_COLUMNS = [
  'font_family',
  'font_size_half_pt',
  'bold',
  'caps',
  'indent_twips',
  'space_before_twips',
  'space_after_twips',
  'numbering_format',
] as const;

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('style_rules', {
    properties: { type: 'jsonb', notNull: true, default: '{}' },
  });
  pgm.sql(SQL_BACKFILL);
  pgm.sql(SQL_ENRICH_LINE);
  pgm.sql(SQL_ENRICH_NUMFMT);
  pgm.dropConstraint('style_rules', 'style_rules_non_negative_ooxml_units_check');
  pgm.dropColumns('style_rules', [...SCALAR_COLUMNS]);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.addColumns('style_rules', {
    font_family: { type: 'text' },
    font_size_half_pt: { type: 'integer' },
    bold: { type: 'boolean', notNull: true, default: false },
    caps: { type: 'boolean', notNull: true, default: false },
    indent_twips: { type: 'integer' },
    space_before_twips: { type: 'integer' },
    space_after_twips: { type: 'integer' },
    numbering_format: { type: 'text' },
  });
  pgm.sql(SQL_BACK_PROJECT);
  pgm.addConstraint('style_rules', 'style_rules_non_negative_ooxml_units_check', {
    check: `
      (font_size_half_pt IS NULL OR font_size_half_pt >= 0) AND
      (indent_twips IS NULL OR indent_twips >= 0) AND
      (space_before_twips IS NULL OR space_before_twips >= 0) AND
      (space_after_twips IS NULL OR space_after_twips >= 0)
    `,
  });
  pgm.dropColumns('style_rules', ['properties']);
};
