import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Default UFGS-derived style template seed.
 *
 * Source fixture: docs/references/UFGS/DIVISION_27/27080001.docx (gitignored)
 * Extraction commands (re-run to verify):
 *   unzip -p docs/references/UFGS/DIVISION_27/27080001.docx word/styles.xml    > /tmp/specr-styles.xml
 *   unzip -p docs/references/UFGS/DIVISION_27/27080001.docx word/numbering.xml > /tmp/specr-numbering.xml
 *
 * Resolved values (basedOn chain + numId=2 abstractNum lookup):
 *
 * Normal style (root):
 *   rFonts ascii="Courier New", sz=20 (half-pt → 10pt), spacing before=0 after=120
 * SpecNormal (basedOn Normal):
 *   adds spacing line=360 before=0 after=0  (overrides Normal spacing)
 *
 * | NodeType | Style    | basedOn chain        | numPr (ilvl/numId) | abstractNum ilvl source | Font        | sz | bold | caps | ind start | before | after | lvlText    |
 * |----------|----------|----------------------|--------------------|-------------------------|-------------|----|------|------|-----------|--------|-------|------------|
 * | part     | PART     | PART→Normal          | ilvl=0, numId=2    | ilvl=0                  | Courier New | 20 | true | true | 0         | 0      | 120   | PART %1 -  |
 * | article  | Article  | Article→Normal       | none (parent-only) | ilvl=1                  | Courier New | 20 | false| true | NULL      | 0      | 120   | %1.%2      |
 * | pr1      | Level11  | Level11→SpecNormal→N | ilvl=2, numId=2    | ilvl=2                  | Courier New | 20 | false| false| 720       | 0      | 0     | %3.        |
 * | pr2      | Level21  | Level21→Level11→…    | inherits ilvl=2    | ilvl=3 (per design map) | Courier New | 20 | false| false| 1080      | 0      | 0     | %4.        |
 * | pr3      | Level31  | Level31→Level21→…    | inherits           | ilvl=4                  | Courier New | 20 | false| false| 1440      | 0      | 0     | %5.        |
 * | pr4      | Level41  | Level41→Level31→…    | inherits           | ilvl=5                  | Courier New | 20 | false| false| 1800      | 0      | 0     | %6)        |
 * | pr5      | Level51  | Level51→Level41→…    | inherits           | ilvl=6                  | Courier New | 20 | false| false| 2160      | 0      | 0     | %7)        |
 *
 * lvlText values normalized to match buildSpecNumberingConfig() (no trailing spaces);
 * the UFGS fixture has trailing spaces on ilvl=0 ("PART %1 - ") and ilvl=1 ("%1.%2 ")
 * but our generator emits the trimmed form. See issue #30 for rationale.
 *
 * Indent values come from the abstractNum level override (per design doc methodology:
 * "abstractNum level override → paragraph style → null"). Spacing values come from
 * the paragraph style basedOn chain (Normal vs SpecNormal). Where extraction yielded
 * no value, we write NULL — never fabricate.
 */

interface SeedRow {
  readonly nodeType: string;
  readonly fontFamily: string | null;
  readonly fontSizeHalfPt: number | null;
  readonly bold: boolean;
  readonly caps: boolean;
  readonly indentTwips: number | null;
  readonly spaceBeforeTwips: number | null;
  readonly spaceAfterTwips: number | null;
  readonly numberingFormat: string | null;
}

const ROWS: readonly SeedRow[] = [
  cn('part', true, true, 0, 0, 120, 'PART %1 -'),
  cn('article', false, true, null, 0, 120, '%1.%2'),
  cn('pr1', false, false, 720, 0, 0, '%3.'),
  cn('pr2', false, false, 1080, 0, 0, '%4.'),
  cn('pr3', false, false, 1440, 0, 0, '%5.'),
  cn('pr4', false, false, 1800, 0, 0, '%6)'),
  cn('pr5', false, false, 2160, 0, 0, '%7)'),
];

function cn(
  nodeType: string,
  bold: boolean,
  caps: boolean,
  indent: number | null,
  before: number | null,
  after: number | null,
  fmt: string
): SeedRow {
  return {
    nodeType,
    fontFamily: 'Courier New',
    fontSizeHalfPt: 20,
    bold,
    caps,
    indentTwips: indent,
    spaceBeforeTwips: before,
    spaceAfterTwips: after,
    numberingFormat: fmt,
  };
}

function sqlLit(v: string | number | boolean | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // Escape single quotes in string literals (defense in depth — seed values are static)
  return `'${v.replace(/'/g, "''")}'`;
}

function insertSql(row: SeedRow): string {
  const cols = [
    row.nodeType,
    row.fontFamily,
    row.fontSizeHalfPt,
    row.bold,
    row.caps,
    row.indentTwips,
    row.spaceBeforeTwips,
    row.spaceAfterTwips,
    row.numberingFormat,
  ];
  const literals = cols.map(sqlLit).join(', ');
  return `INSERT INTO style_rules (
    template_id, node_type, font_family, font_size_half_pt,
    bold, caps, indent_twips, space_before_twips, space_after_twips, numbering_format
  ) SELECT id, ${literals}
    FROM style_templates WHERE name = 'UFGS-Default'`;
}

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`INSERT INTO style_templates (name, owner) VALUES ('UFGS-Default', NULL)`);
  for (const row of ROWS) {
    pgm.sql(insertSql(row));
  }
};

export const down = (pgm: MigrationBuilder): void => {
  const nodeTypeList = ROWS.map((r) => `'${r.nodeType}'`).join(',');
  pgm.sql(
    `DELETE FROM style_rules WHERE template_id IN (SELECT id FROM style_templates WHERE name = 'UFGS-Default') AND node_type IN (${nodeTypeList})`
  );
  pgm.sql(`DELETE FROM style_templates WHERE name = 'UFGS-Default'`);
};
