import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { ProjectNotFoundError } from './derive.js';

// Project-scoped Revit link inventory (#103). Read-only aggregation over the
// revit_parameter_mappings substrate (#46 / revit.ts CRUD) — this module never
// mutates mappings (the write path is #47). It answers the two coordination
// questions the Phase 5 link browser needs: which model elements drive which
// spec sections, and which project specs have no model backing at all.

interface Queryable {
  query: Pool['query'];
}

/** A spec a Revit element links to (element→sections side). */
export interface RevitLinkedSpec {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
}

/** One Revit element (family instance) and the project specs it drives. */
export interface RevitElementLinks {
  readonly revitInstanceId: string;
  readonly specs: readonly RevitLinkedSpec[];
  readonly linkCount: number;
}

/** One project spec and the Revit elements linked to its paragraphs. */
export interface RevitSpecLinks {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly elements: readonly string[];
  readonly linkCount: number;
}

export interface RevitLinkSummary {
  readonly elementCount: number;
  readonly specCount: number;
  readonly mappedSpecCount: number;
  readonly specsWithoutModelBacking: number;
  readonly unmappedElements: number;
  readonly mappingCount: number;
}

/** Optional narrowing of the two views (summary stays project-wide). */
export interface RevitLinkFilter {
  readonly revitInstanceId?: string;
  readonly specId?: string;
}

export interface RevitLinkInventory {
  readonly projectId: string;
  readonly byElement: readonly RevitElementLinks[];
  readonly bySpec: readonly RevitSpecLinks[];
  readonly summary: RevitLinkSummary;
}

interface PresentSpecRow {
  readonly spec_id: string;
  readonly section: string;
  readonly title: string;
}

interface LinkRow {
  readonly revit_instance_id: string;
  readonly spec_id: string;
  readonly section: string;
  readonly title: string;
}

async function assertProject(projectId: string, client: Queryable): Promise<void> {
  const result = await client.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if ((result.rowCount ?? 0) === 0) {
    throw new ProjectNotFoundError(`project ${projectId} not found`);
  }
}

// Present project specs (ADR-030: withdrawn masters never count — a no-op guard
// today since project_specs holds project copies, but it pins the invariant).
async function readPresentSpecs(
  projectId: string,
  client: Queryable
): Promise<readonly PresentSpecRow[]> {
  const result = await client.query<PresentSpecRow>(
    `SELECT s.id AS spec_id, s.section, s.title
     FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
     WHERE ps.project_id = $1 AND s.withdrawn_at IS NULL
     ORDER BY s.section, s.id`,
    [projectId]
  );
  return result.rows;
}

// One row per mapping whose target paragraph belongs to a present project spec.
async function readLinks(projectId: string, client: Queryable): Promise<readonly LinkRow[]> {
  const result = await client.query<LinkRow>(
    `SELECT m.revit_instance_id, s.id AS spec_id, s.section, s.title
     FROM revit_parameter_mappings m
     JOIN paragraphs p ON p.id = m.paragraph_id
     JOIN specs s ON s.id = p.spec_id
     JOIN project_specs ps ON ps.spec_id = s.id AND ps.project_id = $1
     WHERE s.withdrawn_at IS NULL
     ORDER BY s.section, m.revit_instance_id`,
    [projectId]
  );
  return result.rows;
}

function applyFilter(links: readonly LinkRow[], filter: RevitLinkFilter): readonly LinkRow[] {
  return links.filter(
    (row) =>
      (filter.revitInstanceId === undefined || row.revit_instance_id === filter.revitInstanceId) &&
      (filter.specId === undefined || row.spec_id === filter.specId)
  );
}

function groupBy<K>(rows: readonly LinkRow[], key: (row: LinkRow) => K): Map<K, LinkRow[]> {
  const map = new Map<K, LinkRow[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

function distinctSpecs(rows: readonly LinkRow[]): readonly RevitLinkedSpec[] {
  const seen = new Map<string, RevitLinkedSpec>();
  for (const row of rows) {
    if (!seen.has(row.spec_id)) {
      seen.set(row.spec_id, { specId: row.spec_id, section: row.section, title: row.title });
    }
  }
  return [...seen.values()].sort((a, b) => a.section.localeCompare(b.section));
}

function distinctElements(rows: readonly LinkRow[]): readonly string[] {
  return [...new Set(rows.map((row) => row.revit_instance_id))].sort((a, b) => a.localeCompare(b));
}

function buildByElement(links: readonly LinkRow[]): readonly RevitElementLinks[] {
  return [...groupBy(links, (row) => row.revit_instance_id).entries()]
    .map(([revitInstanceId, rows]) => ({
      revitInstanceId,
      specs: distinctSpecs(rows),
      linkCount: rows.length,
    }))
    .sort((a, b) => a.revitInstanceId.localeCompare(b.revitInstanceId));
}

function buildBySpec(
  specs: readonly PresentSpecRow[],
  links: readonly LinkRow[]
): readonly RevitSpecLinks[] {
  const bySpecId = groupBy(links, (row) => row.spec_id);
  return specs.map((spec) => {
    const rows = bySpecId.get(spec.spec_id) ?? [];
    return {
      specId: spec.spec_id,
      section: spec.section,
      title: spec.title,
      elements: distinctElements(rows),
      linkCount: rows.length,
    };
  });
}

// Summary is computed over the FULL project scope (never the filtered views), so
// the counts are stable regardless of any revitInstanceId/specId narrowing.
function summarize(specs: readonly PresentSpecRow[], links: readonly LinkRow[]): RevitLinkSummary {
  const elementIds = new Set(links.map((row) => row.revit_instance_id));
  const mappedSpecIds = new Set(links.map((row) => row.spec_id));
  return {
    elementCount: elementIds.size,
    specCount: specs.length,
    mappedSpecCount: mappedSpecIds.size,
    specsWithoutModelBacking: specs.length - mappedSpecIds.size,
    // KNOWN SUBSTRATE LIMIT (ADR-029 / ADR-049): every in-scope element links, by
    // construction of the join, to a present project spec — so no element is
    // observably "unmapped" from the mappings table alone. A true count of
    // model-placed-but-never-mapped elements needs the deferred model-element
    // registry (#84 family); until then this is 0, kept in the contract so X-84
    // (the coordination report) gains the field with no future breaking change.
    unmappedElements: 0,
    mappingCount: links.length,
  };
}

export async function getProjectRevitLinks(
  projectId: string,
  filter: RevitLinkFilter = {},
  db: Pool = pool
): Promise<RevitLinkInventory> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertProject(projectId, client);
    const specs = await readPresentSpecs(projectId, client);
    const links = await readLinks(projectId, client);
    await client.query('COMMIT');
    const filtered = applyFilter(links, filter);
    const filteredSpecs =
      filter.specId === undefined ? specs : specs.filter((s) => s.spec_id === filter.specId);
    return {
      projectId,
      byElement: buildByElement(filtered),
      bySpec: buildBySpec(filteredSpecs, filtered),
      summary: summarize(specs, links),
    };
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ProjectNotFoundError || err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getProjectRevitLinks failed for project ${projectId}`, { cause: err });
  } finally {
    if (client) client.release();
  }
}
