import type { MigrationBuilder } from 'node-pg-migrate';

const STYLE_NODE_TYPES = [
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
] as const;

const OLD_STYLE_NODE_TYPES = STYLE_NODE_TYPES.filter(
  (nodeType) => nodeType !== 'pr6' && nodeType !== 'pr7'
);

function nodeTypeCheck(nodeTypes: readonly string[]): string {
  const values = nodeTypes.map((nodeType) => `'${nodeType}'`).join(', ');
  return `node_type IN (${values})`;
}

function insertDeepRuleSql(
  sourceNodeType: 'pr4' | 'pr5',
  targetNodeType: 'pr6' | 'pr7',
  lvlText: '%8)' | '%9)',
  numFmt: 'decimal' | 'lowerLetter',
  ilvl: 7 | 8,
  fallbackIndent: 2520 | 2880
): string {
  return `
    WITH source AS (
      SELECT st.id AS template_id, COALESCE(sr.properties, '{}'::jsonb) AS props
      FROM style_templates st
      LEFT JOIN style_rules sr
        ON sr.template_id = st.id AND sr.node_type = '${sourceNodeType}'
    )
    INSERT INTO style_rules (template_id, node_type, properties)
    SELECT
      template_id,
      '${targetNodeType}',
      props
        || jsonb_build_object(
          'pPr',
          COALESCE(props->'pPr', '{}'::jsonb)
            || jsonb_build_object(
              'ind',
              COALESCE(props #> '{pPr,ind}', '{}'::jsonb)
                || jsonb_build_object(
                  'left',
                  CASE
                    WHEN props #>> '{pPr,ind,left}' ~ '^-?\\d+$'
                      THEN (props #>> '{pPr,ind,left}')::int + 720
                    ELSE ${fallbackIndent}
                  END
                )
            )
        )
        || jsonb_build_object(
          'numbering',
          COALESCE(props->'numbering', '{}'::jsonb)
            || jsonb_build_object('lvlText', '${lvlText}', 'numFmt', '${numFmt}', 'ilvl', ${ilvl})
        )
    FROM source
    ON CONFLICT (template_id, node_type) DO NOTHING
  `;
}

export const up = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('style_rules', 'style_rules_node_type_check');
  pgm.addConstraint('style_rules', 'style_rules_node_type_check', {
    check: nodeTypeCheck(STYLE_NODE_TYPES),
  });
  pgm.sql(insertDeepRuleSql('pr4', 'pr6', '%8)', 'decimal', 7, 2520));
  pgm.sql(insertDeepRuleSql('pr5', 'pr7', '%9)', 'lowerLetter', 8, 2880));
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DELETE FROM style_rules WHERE node_type IN ('pr6', 'pr7')`);
  pgm.dropConstraint('style_rules', 'style_rules_node_type_check');
  pgm.addConstraint('style_rules', 'style_rules_node_type_check', {
    check: nodeTypeCheck(OLD_STYLE_NODE_TYPES),
  });
};
