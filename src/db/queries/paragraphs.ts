import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import { bumpSpecContentVersion } from './content-version.js';
import { recordParagraphHistory, resolveHistoryContext } from './paragraph-history.js';
import type { Pool, PoolClient } from 'pg';
import { NodeTypeSchema, parseSourceFacts, deriveArticleRole } from '../../ast/index.js';
import type {
  ObjectMeta,
  ParagraphAssociation,
  SignalConflict,
  SignalProvenance,
  SourceFacts,
  SpecNode,
  SpecNodeInference,
  SpecTree,
} from '../../ast/index.js';
import { listAssociationsForParagraph } from './associations.js';
import { parseNodeType } from './node-type.js';
import { deriveInference } from './inference-meta.js';
import { parseObjectMeta } from './object-meta.js';
import { rewriteObjectTextBlob } from './object-text-edit.js';

export interface Queryable {
  query: Pool['query'];
}
import { logger } from '../../lib/logger.js';

interface FlatRow {
  readonly id: string;
  readonly specId: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly sourceFacts: SourceFacts;
  readonly signalProvenance: SignalProvenance | null;
  /** Captured DOCX body object (#300, ADR-072). Non-null only on `type: 'object'` rows. */
  readonly objectData: ObjectMeta | null;
  /** Manual page break (#497, ADR-075). True === node begins on a new page. */
  readonly pageBreakBefore: boolean;
}

function hasSourceFacts(sourceFacts: SourceFacts): boolean {
  return Object.keys(sourceFacts).length > 0;
}

function flattenDfs(
  nodes: readonly SpecNode[],
  specId: string,
  parentId: string | null,
  rows: FlatRow[]
): void {
  nodes.forEach((node, idx) => {
    rows.push({
      id: node.id,
      specId,
      parentId,
      nodeType: node.type,
      text: node.text,
      position: idx + 1,
      vanish: node.meta.vanish ?? false,
      conflicts: node.meta.conflicts ?? [],
      sourceFacts: node.meta.sourceFacts ?? {},
      signalProvenance: node.meta.inference
        ? { signalUsed: node.meta.inference.signalUsed, agreed: node.meta.inference.agreed }
        : null,
      objectData: node.meta.object ?? null,
      pageBreakBefore: node.meta.pageBreakBefore ?? false,
    });
    flattenDfs(node.children, specId, node.id, rows);
  });
}

export async function insertTree(tree: SpecTree, specId: string, pool: Queryable): Promise<void> {
  const rows: FlatRow[] = [];
  flattenDfs(tree.parts, specId, null, rows);

  if (rows.length === 0) {
    logger.debug({ specId }, 'insertTree: no paragraphs to insert');
    return;
  }

  for (const row of rows) {
    try {
      await pool.query(
        `INSERT INTO paragraphs
           (id, spec_id, parent_id, node_type, text, position, vanish, conflicts, source_facts,
            signal_provenance, object_data, page_break_before)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
        [
          row.id,
          row.specId,
          row.parentId,
          row.nodeType,
          row.text,
          row.position,
          row.vanish,
          JSON.stringify(row.conflicts),
          JSON.stringify(row.sourceFacts),
          row.signalProvenance ? JSON.stringify(row.signalProvenance) : null,
          row.objectData ? JSON.stringify(row.objectData) : null,
          row.pageBreakBefore,
        ]
      );
    } catch (err) {
      throw new DatabaseError(`insertTree: failed to insert paragraph ${row.id}`, { cause: err });
    }
  }
  logger.info({ specId, count: rows.length }, 'insertTree: paragraphs inserted');
}

export interface ParagraphRow {
  readonly id: string;
  readonly nodeType: string;
  readonly text: string;
  readonly vanish: boolean;
  /** Inference signal disagreements (#56). Present only when non-empty. */
  readonly conflicts?: readonly SignalConflict[];
  /** Parser source facts (#131). Present only when non-empty. */
  readonly sourceFacts?: SourceFacts;
  /** Hierarchy-inference confidence (ADR-055). Present only when scored. */
  readonly inference?: SpecNodeInference;
  /** External content associations (#109). Present only when non-empty. */
  readonly associations?: readonly ParagraphAssociation[];
  /** Captured DOCX body object (#300, ADR-072). Present only on `nodeType === 'object'`. */
  readonly object?: ObjectMeta;
  /** Manual page break (#497, ADR-075). Present only when true. */
  readonly pageBreakBefore?: boolean;
}

export interface ParagraphWithAncestors {
  readonly node: ParagraphRow;
  readonly ancestors: readonly ParagraphRow[];
}

interface ChainRow {
  readonly id: string;
  readonly nodeType: string;
  readonly text: string;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly sourceFacts: SourceFacts;
  readonly signalProvenance: unknown;
  readonly objectData: unknown;
  readonly pageBreakBefore: boolean;
  readonly depth: number;
}

function toParagraphRow(r: ChainRow): ParagraphRow {
  // Normalize through the schema so legacy comment facts gain the backfilled
  // `closed` flag before they reach the API response (#262).
  const sourceFacts = parseSourceFacts(r.sourceFacts);
  // ParagraphRow.nodeType is a plain string and paragraphs.node_type carries no
  // CHECK, so a non-enum row must pass through unscored (inference/object omitted) —
  // never fail the whole ancestor read over a value this surface never typed.
  const nodeType = NodeTypeSchema.safeParse(r.nodeType);
  const inference = nodeType.success
    ? deriveInference(r.signalProvenance, r.conflicts, nodeType.data)
    : undefined;
  const objectMeta = nodeType.success
    ? parseObjectMeta(nodeType.data, r.objectData, 'getParagraphWithAncestors')
    : undefined;
  return {
    id: r.id,
    nodeType: r.nodeType,
    text: r.text,
    vanish: r.vanish,
    ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
    ...(hasSourceFacts(sourceFacts) ? { sourceFacts } : {}),
    ...(inference ? { inference } : {}),
    ...(objectMeta ? { object: objectMeta } : {}),
    ...(r.pageBreakBefore ? { pageBreakBefore: true } : {}),
  };
}

/** The spec a paragraph belongs to, or null if no such paragraph exists. The single
 *  source of the paragraph→spec ownership lookup, shared by the REST association
 *  handlers (resolveIds) and the MCP association tools (assertParagraphInSpec) so the
 *  raw SELECT lives in one place, independently testable. */
export async function getParagraphSpecId(
  paragraphId: string,
  db: Queryable = pool
): Promise<string | null> {
  const res = await db.query<{ spec_id: string }>(`SELECT spec_id FROM paragraphs WHERE id = $1`, [
    paragraphId,
  ]);
  return res.rows[0]?.spec_id ?? null;
}

export async function getParagraphWithAncestors(
  id: string
): Promise<ParagraphWithAncestors | null> {
  try {
    const result = await pool.query<ChainRow>(
      `WITH RECURSIVE chain AS (
         SELECT id, node_type, text, vanish, conflicts, source_facts, signal_provenance,
                object_data, page_break_before, parent_id, 0 AS depth
         FROM paragraphs WHERE id = $1
         UNION ALL
         SELECT p.id, p.node_type, p.text, p.vanish, p.conflicts, p.source_facts,
                p.signal_provenance, p.object_data, p.page_break_before, p.parent_id, c.depth + 1
         FROM paragraphs p JOIN chain c ON p.id = c.parent_id
         WHERE c.depth + 1 < 10
       )
       SELECT id, node_type AS "nodeType", text, vanish, conflicts,
              source_facts AS "sourceFacts", signal_provenance AS "signalProvenance",
              object_data AS "objectData", page_break_before AS "pageBreakBefore", depth
       FROM chain ORDER BY depth DESC`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const rows = result.rows;
    const node = rows[rows.length - 1]!;
    const ancestors = rows.slice(0, -1);
    const associations = await listAssociationsForParagraph(id);
    const nodeRow = toParagraphRow(node);
    return {
      node: associations.length > 0 ? { ...nodeRow, associations } : nodeRow,
      ancestors: ancestors.map(toParagraphRow),
    };
  } catch (err) {
    throw new DatabaseError('getParagraphWithAncestors failed', { cause: err });
  }
}

interface SubtreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly sourceFacts: SourceFacts;
  readonly signalProvenance: unknown;
  readonly objectData: unknown;
}

/** Assemble subtree rows (a node plus all its descendants) into one SpecNode
 *  rooted at `rootId`. Mirrors buildNodeTree's meta shaping (specs.ts) but roots
 *  at a non-null parent rather than the forest roots. */
function buildSubtree(rows: readonly SubtreeRow[], rootId: string): SpecNode | null {
  const childrenByParent = new Map<string | null, SubtreeRow[]>();
  for (const row of rows) {
    childrenByParent.set(row.parentId, [...(childrenByParent.get(row.parentId) ?? []), row]);
  }
  const root = rows.find((r) => r.id === rootId);
  if (!root) return null;

  const build = (row: SubtreeRow): SpecNode => {
    // Normalize through the schema so legacy comment facts gain the backfilled
    // `closed` flag before they reach the API response (#262).
    const sourceFacts = parseSourceFacts(row.sourceFacts);
    const articleRole = row.nodeType === 'article' ? deriveArticleRole(row.text) : undefined;
    const nodeType = parseNodeType(row.nodeType, 'buildSubtree');
    const inference = deriveInference(row.signalProvenance, row.conflicts, nodeType);
    const objectMeta = parseObjectMeta(nodeType, row.objectData, 'buildSubtree');
    return {
      id: row.id,
      type: nodeType,
      text: row.text,
      children: (childrenByParent.get(row.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map(build),
      meta: {
        ...(row.vanish ? { vanish: true } : {}),
        ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
        ...(hasSourceFacts(sourceFacts) ? { sourceFacts } : {}),
        ...(articleRole !== undefined ? { articleRole } : {}),
        ...(inference ? { inference } : {}),
        ...(objectMeta ? { object: objectMeta } : {}),
      },
    };
  };

  return build(root);
}

/** Outcome of {@link updateParagraphText}: the spec/node pairing is validated
 *  before any write so the API can map `not-found` → 404, `wrong-spec` → 403,
 *  and `locked-object` → 422 (#519, ADR-072 decision 3): an `object` row's
 *  content is a captured OOXML blob, editable only through its `objectText`
 *  children, never by replacing the row's own `text` directly. */
export type UpdateParagraphResult =
  | { readonly status: 'updated'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'locked-object'; readonly nodeType: string };

/** The single source of truth for the `locked-object` rejection text (#519 review
 *  finding): the REST 422 (src/api/paragraphs.ts) and the MCP tool error
 *  (src/mcp/paragraph-handlers.ts) both call this instead of each hand-copying its
 *  own template literal, so the two surfaces cannot silently diverge in wording —
 *  their integration tests assert the exact string this returns, not just a
 *  substring. */
export function lockedObjectMessage(nodeType: string): string {
  return `node type "${nodeType}" is locked and cannot be edited directly — edit its objectText child instead`;
}

// Exported for the sibling-insert module (paragraph-insert.ts, #372) — every
// paragraph write path returns the same reconstructed SpecNode shape.
export async function fetchSubtreeNode(
  db: Queryable,
  specId: string,
  nodeId: string
): Promise<SpecNode | null> {
  const result = await db.query<SubtreeRow>(
    `WITH RECURSIVE subtree AS (
       SELECT id, parent_id, node_type, text, position, vanish, conflicts, source_facts,
              signal_provenance, object_data
       FROM paragraphs WHERE id = $1 AND spec_id = $2
       UNION ALL
       SELECT p.id, p.parent_id, p.node_type, p.text, p.position, p.vanish,
              p.conflicts, p.source_facts, p.signal_provenance, p.object_data
       FROM paragraphs p JOIN subtree s ON p.parent_id = s.id
       WHERE p.spec_id = $2
     )
     SELECT id, parent_id AS "parentId", node_type AS "nodeType", text, position,
            vanish, conflicts, source_facts AS "sourceFacts",
            signal_provenance AS "signalProvenance", object_data AS "objectData"
     FROM subtree`,
    [nodeId, specId]
  );
  return buildSubtree(result.rows, nodeId);
}

/**
 * Update a single paragraph's text by UUID, bumping `base_version` and
 * `updated_at` (ADR-009, #47). The (specId, nodeId) pair is verified under a row
 * lock before the write so a node that exists but belongs to another spec is
 * reported as `wrong-spec`, never silently edited.
 *
 * The write passes the composed edit gate first (ADR-018): the spec must be
 * writable (lifecycle + external state) and, when `expectedVersion` is given,
 * at that version — a stale value throws `StaleVersionError` rather than
 * clobbering a concurrent edit. A successful write bumps `specs.content_version`
 * so the next optimistic precondition sees the change.
 */
/** Owner row {@link applyParagraphUpdate} needs before it may write: the
 *  spec/node-type pairing to validate, `baseVersion` to compute the next
 *  version, and `parentId` — `paragraphs.parent_id` is a real indexed
 *  self-FK column (migration 003), so an `objectText` row's parent `object`
 *  row is available with no separate join. */
async function fetchUpdateOwnerRow(
  client: PoolClient,
  nodeId: string
): Promise<
  { specId: string; nodeType: string; baseVersion: number; parentId: string | null } | undefined
> {
  const owner = await client.query<{
    spec_id: string;
    node_type: string;
    base_version: number;
    parent_id: string | null;
  }>(
    `SELECT spec_id, node_type, base_version, parent_id FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const row = owner.rows[0];
  if (!row) return undefined;
  return {
    specId: row.spec_id,
    nodeType: row.node_type,
    baseVersion: row.base_version,
    parentId: row.parent_id,
  };
}

/** Validates the fetched owner row before any write: `not-found` (no such
 *  row), `wrong-spec` (UUIDs compared case-insensitively — `pg` returns
 *  `spec_id` lowercased while `z.uuid()` preserves an uppercase input, so an
 *  uppercase specId must not false-403), and `locked-object` — an `object`
 *  row's content is a captured OOXML blob, editable only through its
 *  `objectText` children (#519, ADR-072 decision 3), never by replacing the
 *  row's own `text` directly. Returns `null` when the write may proceed. */
function validateUpdateOwner(
  owner: { specId: string; nodeType: string; parentId: string | null } | undefined,
  specId: string
): UpdateParagraphResult | null {
  if (!owner) return { status: 'not-found' };
  if (owner.specId.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };
  if (owner.nodeType === 'object') return { status: 'locked-object', nodeType: owner.nodeType };
  return null;
}

/** After the generic text write below, an `objectText` row also needs its
 *  parent `object` row's captured blob rewritten (#519): DOCX regeneration
 *  reads body-object content only from `object_data.blob`, never from an
 *  `objectText` row's own `text` column. A no-op for every other node type.
 *  Throws `DatabaseError` if an `objectText` row somehow carries no parent —
 *  every `objectText` node is inserted as an `object` node's child
 *  (insertTree/flattenDfs), so a null `parentId` here is a data-integrity
 *  fault, never a silent skip. */
async function rewriteObjectTextIfNeeded(
  client: PoolClient,
  specId: string,
  owner: { parentId: string | null; nodeType: string },
  nodeId: string,
  text: string
): Promise<void> {
  if (owner.nodeType !== 'objectText') return;
  if (!owner.parentId) {
    throw new DatabaseError(
      `applyParagraphUpdate: objectText node ${nodeId} has no parent object row to rewrite`
    );
  }
  await rewriteObjectTextBlob(client, specId, owner.parentId, nodeId, text);
}

/** In-transaction body of {@link updateParagraphText}: gate → ownership check →
 *  write paragraph → rewrite the parent object blob when the target is an
 *  `objectText` row (#519) → snapshot the post-write text (#377, ADR-052 D1)
 *  → bump specs.content_version. On a non-'updated' outcome the caller rolls
 *  back; on 'updated' the caller commits. */
async function applyParagraphUpdate(
  client: PoolClient,
  specId: string,
  nodeId: string,
  text: string,
  expectedVersion?: number,
  actorLabel?: string
): Promise<UpdateParagraphResult> {
  // Gate first: row-locks the spec and validates lifecycle/external/version
  // before any paragraph write. Throws typed errors (forbidden / stale). The
  // returned contentVersion is the pre-bump generation this write belongs to.
  const gate = await assertSpecWritable(client, specId, expectedVersion);

  const ownerRow = await fetchUpdateOwnerRow(client, nodeId);
  const invalid = validateUpdateOwner(ownerRow, specId);
  if (invalid) return invalid;
  // Unreachable in practice: validateUpdateOwner only returns null when
  // ownerRow is defined. Kept so strict-null-checks can narrow ownerRow below
  // without a non-null assertion (banned outside tests).
  if (!ownerRow) {
    throw new DatabaseError('applyParagraphUpdate: owner row missing after passing validation');
  }

  const nextVersion = ownerRow.baseVersion + 1;
  await client.query(
    `UPDATE paragraphs SET text = $2, base_version = $3, updated_at = now() WHERE id = $1`,
    [nodeId, text, nextVersion]
  );
  await rewriteObjectTextIfNeeded(client, specId, ownerRow, nodeId, text);

  const historyContext = await resolveHistoryContext(client, gate.contentVersion, actorLabel);
  await recordParagraphHistory(client, {
    paragraphId: nodeId,
    specId,
    version: nextVersion,
    text,
    nodeType: ownerRow.nodeType,
    op: 'edit',
    contentVersion: historyContext.contentVersion,
    userId: historyContext.userId,
    payload: null,
  });

  await bumpSpecContentVersion(client, specId);

  const node = await fetchSubtreeNode(client, specId, nodeId);
  if (!node) throw new DatabaseError('updateParagraphText: updated node vanished mid-transaction');
  return { status: 'updated', node };
}

export async function updateParagraphText(
  specId: string,
  nodeId: string,
  text: string,
  expectedVersion?: number,
  actorLabel?: string
): Promise<UpdateParagraphResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyParagraphUpdate(
      client,
      specId,
      nodeId,
      text,
      expectedVersion,
      actorLabel
    );
    await client.query(result.status === 'updated' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('updateParagraphText failed', { cause: err });
  } finally {
    client.release();
  }
}

// setParagraphVanish / SetVanishResult / setVanishRow moved to
// paragraph-vanish.ts (#374) — the same DB-core split already applied to
// sibling insertion (paragraph-insert.ts, #372), so the merge engine's
// deleted-op apply can reuse the gate-free core.
