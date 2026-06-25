import type { Pool } from 'pg';
import {
  buildTitleKeywordIndex,
  findImpliedRelatedSections,
  type ImpliedRelatedSectionFinding,
  type SectionTitleEntry,
  type SourceParagraph,
  type SourceSpecBody,
} from '../../coordination/index.js';
import type { ClassifiedRef } from './article-refs.js';

interface Queryable {
  query: Pool['query'];
}

interface PresentSpec {
  readonly specId: string;
  readonly section: string;
}

interface ParagraphRow {
  readonly source_spec_id: string;
  readonly id: string;
  readonly text: string;
}

async function readCatalog(
  projectId: string,
  packageId: string | undefined,
  client: Queryable
): Promise<readonly SectionTitleEntry[]> {
  const presentSql =
    packageId === undefined
      ? `SELECT s.section, s.title, 0 AS rank, 0 AS source_priority
         FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
         WHERE ps.project_id = $1`
      : `SELECT s.section, s.title, 0 AS rank, 0 AS source_priority
         FROM package_specs ks JOIN specs s ON s.id = ks.spec_id
         WHERE ks.package_id = $2`;
  const requiredWhere =
    packageId === undefined
      ? `r.project_id = $1 AND r.package_id IS NULL`
      : `r.project_id = $1 AND r.package_id = $2`;
  const params = packageId === undefined ? [projectId] : [projectId, packageId];
  const r = await client.query<{ section: string; title: string }>(
    `WITH catalog AS (
       ${presentSql}
       UNION ALL
       SELECT r.section, COALESCE(r.title, ss.title), 1 AS rank, 0 AS source_priority
       FROM required_sections r
       LEFT JOIN spec_sections ss ON ss.section_number = r.section
       WHERE ${requiredWhere}
       UNION ALL
       SELECT s.section, s.title, 2 AS rank, ps.priority AS source_priority
       FROM project_sources ps
       JOIN specs s ON s.library_id = ps.library_id
       WHERE ps.project_id = $1
     )
     SELECT DISTINCT ON (section) section, title
     FROM catalog
     WHERE title IS NOT NULL AND btrim(title) <> ''
     ORDER BY section, rank, source_priority, title`,
    params
  );
  return r.rows.map((row) => ({ section: row.section, title: row.title }));
}

async function readParagraphs(
  specIds: readonly string[],
  client: Queryable
): Promise<readonly ParagraphRow[]> {
  if (specIds.length === 0) return [];
  const r = await client.query<ParagraphRow>(
    `SELECT p.spec_id AS source_spec_id, p.id, p.text
     FROM paragraphs p
     WHERE p.spec_id = ANY($1::uuid[])
       AND p.vanish = false
       AND btrim(p.text) <> ''
     ORDER BY p.spec_id, p.position, p.id`,
    [specIds]
  );
  return r.rows;
}

function relatedSectionsBySpec(
  classified: readonly ClassifiedRef[]
): ReadonlyMap<string, string[]> {
  const bySpec = new Map<string, string[]>();
  for (const ref of classified) {
    if (ref.targetType !== 'section' || ref.ancestorRole !== 'related-sections') continue;
    bySpec.set(ref.sourceSpecId, [...(bySpec.get(ref.sourceSpecId) ?? []), ref.value]);
  }
  return bySpec;
}

function bodyCitedSectionsBySpec(
  classified: readonly ClassifiedRef[]
): ReadonlyMap<string, string[]> {
  const bySpec = new Map<string, string[]>();
  for (const ref of classified) {
    if (ref.targetType !== 'section' || ref.ancestorRole === 'related-sections') continue;
    bySpec.set(ref.sourceSpecId, [...(bySpec.get(ref.sourceSpecId) ?? []), ref.value]);
  }
  return bySpec;
}

function paragraphsBySpec(rows: readonly ParagraphRow[]): ReadonlyMap<string, SourceParagraph[]> {
  const bySpec = new Map<string, SourceParagraph[]>();
  for (const row of rows) {
    bySpec.set(row.source_spec_id, [...(bySpec.get(row.source_spec_id) ?? []), row]);
  }
  return bySpec;
}

function sourceBodies(
  present: readonly PresentSpec[],
  paragraphs: readonly ParagraphRow[],
  classified: readonly ClassifiedRef[]
): readonly SourceSpecBody[] {
  const related = relatedSectionsBySpec(classified);
  const bodyCited = bodyCitedSectionsBySpec(classified);
  const bodies = paragraphsBySpec(paragraphs);
  return present.map((spec) => ({
    specId: spec.specId,
    section: spec.section,
    relatedSections: related.get(spec.specId) ?? [],
    bodyCitedSections: bodyCited.get(spec.specId) ?? [],
    paragraphs: bodies.get(spec.specId) ?? [],
  }));
}

export async function readImpliedRelatedFindings(
  projectId: string,
  packageId: string | undefined,
  present: readonly PresentSpec[],
  classified: readonly ClassifiedRef[],
  client: Queryable
): Promise<readonly ImpliedRelatedSectionFinding[]> {
  const catalog = await readCatalog(projectId, packageId, client);
  const paragraphs = await readParagraphs(
    present.map((p) => p.specId),
    client
  );
  return findImpliedRelatedSections({
    catalog: buildTitleKeywordIndex(catalog),
    specs: sourceBodies(present, paragraphs, classified),
  });
}
