import type { PoolClient } from 'pg';
import { DatabaseError } from '../errors.js';
import { SpecTreeSchema } from '../../ast/index.js';
import type { SpecTree, SpecNode } from '../../ast/index.js';
import { buildNodeTree } from './specs.js';
import type { ParagraphTreeRow } from './specs.js';
import { parseStoredPageSize } from './spec-page-size.js';

// Snapshot side of package revisions (ADR-015 D5), split out of revisions.ts
// to keep that file within the 400-line budget: freezing member trees at
// issuance and validating frozen trees on both write and read.

/** A snapshot tree failed SpecTreeSchema validation. At write → 422 (the
 *  package content cannot be issued); at read → 500 (integrity failure). */
export class SnapshotValidationError extends DatabaseError {}

export interface RevisionSpecEntry {
  readonly specId: string;
  readonly position: number;
  readonly tree: SpecTree;
}

interface MemberRow {
  readonly spec_id: string;
  readonly section: string | null;
  readonly title: string | null;
  readonly position: number;
  readonly page_size: unknown;
}

/** `paras` row shape, extended with the live paragraph's own project-copy
 *  lineage column (migration 018) — the source `embedOriginIds` reads to
 *  populate `meta.originParagraphId` at freeze time (#392, ADR-078). Local to
 *  this file so `ParagraphTreeRow`/`buildNodeTree` (specs.ts) stay untouched —
 *  the live `GET /specs/:id/tree` path never selects this column. */
interface SnapshotParagraphRow extends ParagraphTreeRow {
  readonly originParagraphId: string | null;
}

/** Freeze-time-only embedding (#392, ADR-078): stamps each node's
 *  `meta.originParagraphId` from the live paragraph it was built from, omitted
 *  (never `null`) when the paragraph carries no lineage. Mirrors
 *  `attachAssociations` (associations.ts) — same map-by-id-then-recurse shape. */
function embedOriginIds(
  nodes: readonly SpecNode[],
  originById: ReadonlyMap<string, string | null>
): readonly SpecNode[] {
  return nodes.map((node) => {
    const originParagraphId = originById.get(node.id);
    const children = embedOriginIds(node.children, originById);
    return {
      ...node,
      children,
      meta: {
        ...node.meta,
        ...(originParagraphId ? { originParagraphId } : {}),
      },
    };
  });
}

export function validateTree(candidate: unknown, specId: string): SpecTree {
  const parsed = SpecTreeSchema.safeParse(candidate);
  if (!parsed.success) {
    // User-facing via the 422 surface at write — no function-name prefix.
    throw new SnapshotValidationError(
      `snapshot tree for spec ${specId} failed SpecTree validation`,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

/** Freeze every member section's tree, in membership order. */
export async function snapshotMemberTrees(
  packageId: string,
  client: PoolClient
): Promise<readonly RevisionSpecEntry[]> {
  const members = await client.query<MemberRow>(
    `SELECT ps.spec_id, ps.position, s.section, s.title, s.page_size
     FROM package_specs ps JOIN specs s ON s.id = ps.spec_id
     WHERE ps.package_id = $1 ORDER BY ps.position`,
    [packageId]
  );
  const entries: RevisionSpecEntry[] = [];
  for (const member of members.rows) {
    // object_data must be selected alongside every other ParagraphTreeRow
    // column (matches getSpecTree's own query in specs.ts) — buildNodeTree's
    // parseObjectMeta reads it unconditionally for every `object`-typed row.
    // Omitting it left any package containing a captured table/text box unable
    // to snapshot at all: parseObjectMeta rejects the resulting `undefined`
    // against ObjectMetaSchema and throws, surfacing as an unconditional 500
    // from createPackageRevision and (ADR-079, #406) from
    // GET /packages/:id/readiness-report's body_object_present detection.
    // Pre-existing gap (#300/ADR-072 objects predate both PRs), not introduced
    // by the #392 lineage column below.
    const paras = await client.query<SnapshotParagraphRow>(
      `SELECT id, parent_id, node_type, text, position, vanish, conflicts, source_facts,
              signal_provenance, classification, editability_override, object_data,
              page_break_before,
              origin_paragraph_id AS "originParagraphId"
       FROM paragraphs WHERE spec_id = $1`,
      [member.spec_id]
    );
    // #509/ADR-077: freeze the captured page size, normalized through the same
    // parseStoredPageSize boundary contract as getSpecTree — malformed JSONB
    // degrades to the Letter default instead of blocking revision creation.
    const pageSize = parseStoredPageSize(member.page_size);
    const originById = new Map(paras.rows.map((row) => [row.id, row.originParagraphId]));
    const candidate = {
      id: member.spec_id,
      section: member.section ?? '',
      title: member.title ?? '',
      parts: embedOriginIds(buildNodeTree(paras.rows), originById),
      ...(pageSize !== undefined ? { pageSize } : {}),
    };
    entries.push({
      specId: member.spec_id,
      position: member.position,
      tree: validateTree(candidate, member.spec_id),
    });
  }
  return entries;
}

export async function insertSnapshotRows(
  revisionId: string,
  entries: readonly RevisionSpecEntry[],
  client: PoolClient
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO package_revision_specs (revision_id, spec_id, position, tree)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [revisionId, entry.specId, entry.position, JSON.stringify(entry.tree)]
    );
  }
}
