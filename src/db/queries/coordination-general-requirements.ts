import type { Pool } from 'pg';
import {
  buildGeneralRequirementDuplication,
  type GeneralRequirementArticle,
  type GeneralRequirementDuplicationResult,
  type GeneralRequirementScopeSpec,
} from '../../coordination/index.js';

interface Queryable {
  query: Pool['query'];
}

interface ArticleRow {
  readonly spec_id: string;
  readonly section: string;
  readonly paragraph_id: string;
  readonly title: string;
  readonly part_number: number;
}

function toArticle(row: ArticleRow): GeneralRequirementArticle {
  return {
    specId: row.spec_id,
    section: row.section,
    paragraphId: row.paragraph_id,
    title: row.title,
    partNumber: row.part_number,
  };
}

async function readArticles(
  specIds: readonly string[],
  client: Queryable
): Promise<readonly GeneralRequirementArticle[]> {
  if (specIds.length === 0) return [];
  const result = await client.query<ArticleRow>(
    `WITH numbered_parts AS (
       SELECT id, spec_id,
              (ROW_NUMBER() OVER (PARTITION BY spec_id ORDER BY position, id))::int AS part_number
       FROM paragraphs
       WHERE spec_id = ANY($1::uuid[])
         AND node_type = 'part'
         AND parent_id IS NULL
         AND vanish = false
     )
     SELECT article.spec_id, specs.section, article.id AS paragraph_id,
            article.text AS title, part.part_number
     FROM paragraphs article
     JOIN numbered_parts part
       ON part.id = article.parent_id
      AND part.spec_id = article.spec_id
     JOIN specs ON specs.id = article.spec_id
     WHERE article.spec_id = ANY($1::uuid[])
       AND article.node_type = 'article'
       AND article.vanish = false
     ORDER BY specs.section, article.position, article.id`,
    [specIds]
  );
  return result.rows.map(toArticle);
}

export async function readGeneralRequirementDuplication(
  scope: readonly GeneralRequirementScopeSpec[],
  client: Queryable
): Promise<GeneralRequirementDuplicationResult> {
  const articles = await readArticles(
    scope.map((spec) => spec.specId),
    client
  );
  return buildGeneralRequirementDuplication(scope, articles);
}
