import { pool, DatabaseError } from '../index.js';

export interface StyleRule {
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

export interface TemplateMeta {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly createdAt: Date;
}

export interface Template extends TemplateMeta {
  readonly rules: readonly StyleRule[];
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly created_at: Date;
}

interface StyleRuleRow {
  readonly node_type: string;
  readonly font_family: string | null;
  readonly font_size_half_pt: number | null;
  readonly bold: boolean;
  readonly caps: boolean;
  readonly indent_twips: number | null;
  readonly space_before_twips: number | null;
  readonly space_after_twips: number | null;
  readonly numbering_format: string | null;
}

function mapRuleRow(row: StyleRuleRow): StyleRule {
  return {
    nodeType: row.node_type,
    fontFamily: row.font_family,
    fontSizeHalfPt: row.font_size_half_pt,
    bold: row.bold,
    caps: row.caps,
    indentTwips: row.indent_twips,
    spaceBeforeTwips: row.space_before_twips,
    spaceAfterTwips: row.space_after_twips,
    numberingFormat: row.numbering_format,
  };
}

function mapMetaRow(row: TemplateRow): TemplateMeta {
  return { id: row.id, name: row.name, owner: row.owner, createdAt: row.created_at };
}

async function loadRules(templateId: string): Promise<readonly StyleRule[]> {
  const result = await pool.query<StyleRuleRow>(
    `SELECT node_type, font_family, font_size_half_pt, bold, caps,
            indent_twips, space_before_twips, space_after_twips, numbering_format
     FROM style_rules WHERE template_id = $1
     ORDER BY node_type`,
    [templateId]
  );
  return result.rows.map(mapRuleRow);
}

export async function getTemplate(id: string): Promise<Template | null> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT id, name, owner, created_at FROM style_templates WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const rules = await loadRules(row.id);
    return { ...mapMetaRow(row), rules };
  } catch (err) {
    throw new DatabaseError('failed to get template by id', { cause: err });
  }
}

export async function getTemplateByName(name: string): Promise<Template | null> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT id, name, owner, created_at FROM style_templates WHERE name = $1`,
      [name]
    );
    const row = result.rows[0];
    if (!row) return null;
    const rules = await loadRules(row.id);
    return { ...mapMetaRow(row), rules };
  } catch (err) {
    throw new DatabaseError('failed to get template by name', { cause: err });
  }
}

export async function listTemplates(): Promise<readonly TemplateMeta[]> {
  try {
    const result = await pool.query<TemplateRow>(
      `SELECT id, name, owner, created_at FROM style_templates ORDER BY name`
    );
    return result.rows.map(mapMetaRow);
  } catch (err) {
    throw new DatabaseError('failed to list templates', { cause: err });
  }
}

export async function createTemplate(name: string, owner?: string): Promise<TemplateMeta> {
  try {
    const result = await pool.query<TemplateRow>(
      `INSERT INTO style_templates (name, owner) VALUES ($1, $2)
       RETURNING id, name, owner, created_at`,
      [name, owner ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createTemplate: no row returned');
    return mapMetaRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create template', { cause: err });
  }
}

export async function upsertStyleRule(templateId: string, rule: StyleRule): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO style_rules (
         template_id, node_type, font_family, font_size_half_pt,
         bold, caps, indent_twips, space_before_twips, space_after_twips, numbering_format
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (template_id, node_type) DO UPDATE SET
         font_family = EXCLUDED.font_family,
         font_size_half_pt = EXCLUDED.font_size_half_pt,
         bold = EXCLUDED.bold,
         caps = EXCLUDED.caps,
         indent_twips = EXCLUDED.indent_twips,
         space_before_twips = EXCLUDED.space_before_twips,
         space_after_twips = EXCLUDED.space_after_twips,
         numbering_format = EXCLUDED.numbering_format`,
      [
        templateId,
        rule.nodeType,
        rule.fontFamily,
        rule.fontSizeHalfPt,
        rule.bold,
        rule.caps,
        rule.indentTwips,
        rule.spaceBeforeTwips,
        rule.spaceAfterTwips,
        rule.numberingFormat,
      ]
    );
  } catch (err) {
    throw new DatabaseError('failed to upsert style rule', { cause: err });
  }
}
