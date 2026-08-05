import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import { bumpSpecContentVersion } from './content-version.js';
import { recordParagraphHistory, resolveHistoryContext } from './paragraph-history.js';
import type { PoolClient } from 'pg';
import type { InsertableNodeType, SpecNode } from '../../ast/index.js';
import { InsertableNodeTypeSchema } from '../../ast/index.js';
import { fetchSubtreeNode } from './paragraphs.js';

// Sibling paragraph insertion (#372): the DB primitive behind the WYSIWYG
// Enter gesture, and the one the merge engine's added-op apply (#374) will
// reuse. Inserts a new node immediately after an anchor, under the anchor's
// parent, shifting the following siblings' positions — the same mechanic as
// the accept-comment-as-note materialization (reclassify.ts), generalized to
// caller-chosen body/heading types.

/** Outcome of {@link insertSiblingRow}. `invalid-type` carries the type that
 *  was refused — an explicit request outside the insertable set (schema-blocked
 *  at the API, but the DB revalidates), a defaulted non-insertable anchor type
 *  (part/note), a root (PART) anchor, which has no insertable sibling
 *  regardless of an explicit override, or an explicit type that IS insertable
 *  in general but is structurally incompatible with THIS anchor's tier — e.g.
 *  `pr1` after an `article` anchor, or `article` after a `pr1` anchor. Both
 *  would land the new row at the anchor's parent, one CSI tier removed from
 *  where that type belongs (#383). See {@link resolveInsertableNodeType} for
 *  the sibling-compatibility rule, including its one deliberate exception
 *  (a TIERLESS anchor — `note` or `continuation`).
 *
 *  The last four statuses are only reachable when `input.explicitId` is set —
 *  the merge engine's added-op apply (#374). The standalone
 *  {@link insertParagraphAfter} never sets it, so its narrowed return type
 *  ({@link StandaloneInsertResult}) excludes them and the REST/MCP insert
 *  callers stay exhaustive without dead branches:
 *  - `exists` — the explicit id already names a same-spec row with matching
 *    text (an idempotent re-submitted accept); a no-op, not a duplicate.
 *  - `structural-anchor` — the anchor is a structural node (part/article/note);
 *    an orphan addition carries no tier information, so it cannot be inferred as
 *    that node's sibling (a documented KNOWN AMBIGUITY, ADR-005).
 *  - `id-collision` — the explicit id already names a row in a DIFFERENT spec
 *    (the PK is global); reusing it here is never valid.
 *  - `id-mismatch` — the explicit id names a same-spec row whose text differs
 *    from the addition's, so the diff no longer matches current state. */
export type InsertParagraphResult =
  | {
      readonly status: 'created';
      readonly node: SpecNode;
      /** The new sibling's parent/position, sourced from the anchor row
       *  {@link insertSiblingRow} already holds — SpecNode itself carries
       *  neither, so the write-history payload (#377) widens the result here
       *  instead of re-querying. */
      readonly parentId: string | null;
      readonly position: number;
    }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'invalid-type'; readonly nodeType: string }
  | { readonly status: 'exists'; readonly id: string }
  | { readonly status: 'structural-anchor'; readonly nodeType: string }
  | { readonly status: 'id-collision'; readonly ownerSpecId: string }
  | { readonly status: 'id-mismatch' };

/** The subset of {@link InsertParagraphResult} the standalone
 *  {@link insertParagraphAfter} can return: it never sets `input.explicitId`,
 *  so the four merge-only statuses above are unreachable and excluded here,
 *  keeping the REST switch and MCP handler exhaustive over exactly these. */
export type StandaloneInsertResult = Exclude<
  InsertParagraphResult,
  { readonly status: 'exists' | 'structural-anchor' | 'id-collision' | 'id-mismatch' }
>;

// Body/leaf tiers (pr1–pr7 + continuation) — the only anchor types an orphan
// merge addition can safely become a sibling of. Anything else (part/article/
// note) is structural: it carries a fixed CSI role the orphan cannot inherit.
const BODY_TIER_NODE_TYPES: ReadonlySet<string> = new Set([
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
  'continuation',
]);

export interface InsertParagraphInput {
  readonly anchorNodeId: string;
  readonly text: string;
  readonly nodeType?: InsertableNodeType;
  readonly expectedVersion?: number;
  /** Force this UUID onto the new row instead of the default
   *  `gen_random_uuid()` — the merge engine's added-op apply (#374) reuses
   *  the diff-synthesized uuid so a re-submitted/retried accept is
   *  idempotent (short-circuits to `exists`) rather than duplicating rows. */
  readonly explicitId?: string;
  /** Attributes the write-history snapshot (#377) to a named actor; falls
   *  back to the SYSTEM_ACTOR_LABEL sentinel (paragraph-history.ts) when
   *  omitted. */
  readonly actorLabel?: string;
}

interface AnchorRow {
  readonly spec_id: string;
  readonly parent_id: string | null;
  readonly position: number;
  readonly node_type: string;
}

type NodeTypeResolution =
  | { readonly ok: true; readonly nodeType: string }
  | { readonly ok: false; readonly result: InsertParagraphResult };

// Anchor types that carry NO CSI tier of their own (#383). A `note` is an
// editorial aside, not a body paragraph; a `continuation` continues the
// PRECEDING node's text and inherits whatever tier that node has. Neither
// states a tier, so neither can constrain the tier of what follows it — see
// the KNOWN AMBIGUITY on {@link isSiblingCompatible}.
const TIERLESS_ANCHOR_NODE_TYPES: ReadonlySet<string> = new Set(['note', 'continuation']);

/** Is `nodeType` a legal SIBLING of `anchorNodeType` (same parent_id)? Pure,
 *  called only after `nodeType` has already passed the insertable-set check —
 *  this narrows further, from "insertable somewhere" to "insertable HERE".
 *
 *  Three ways to pass (#383 — settled by the repository owner, not
 *  re-litigated here):
 *  1. `nodeType === anchorNodeType` — the general rule. insertSiblingRow
 *     always writes the new row at the anchor's OWN parent_id, so a sibling's
 *     only proven-legal type is the type the anchor itself already
 *     demonstrates as legal there (e.g. pr2 is never a sibling of pr1 — pr2
 *     nests AS a pr1's child, so pr1-after-pr1 is the only same-tier explicit
 *     type an article's pr1 children accept).
 *  2. `nodeType === 'continuation'` — a continuation carries no CSI tier of
 *     its own; it continues the PRECEDING node's text and is legal at any
 *     tier.
 *  3. `anchorNodeType` is TIERLESS (`note` or `continuation`) — KNOWN
 *     AMBIGUITY (#383): the constraint in rule 1 only works because the anchor
 *     DEMONSTRATES a legal tier at its parent. A tierless anchor demonstrates
 *     nothing: a `note` is an editorial aside and a `continuation` merely
 *     continues the preceding node's text, so neither states a tier of its own
 *     and neither can constrain the tier of what follows it. Both legitimately
 *     interleave among body paragraphs of any tier — a `pr1` after a
 *     `continuation` that itself follows a `pr1` is ordinary, well-formed
 *     content. Permit any already-insertable type here rather than guessing a
 *     tier from a node that doesn't have one: deriving it from the target
 *     PARENT instead is the parent→child table this rule deliberately avoids,
 *     which mis-rejects ilvl-gapped legacy data (the CPI offset case, where a
 *     `pr3` legitimately sits under an `article`). Deliberately permissive,
 *     not an oversight. */
function isSiblingCompatible(anchorNodeType: string, nodeType: string): boolean {
  return (
    nodeType === anchorNodeType ||
    nodeType === 'continuation' ||
    TIERLESS_ANCHOR_NODE_TYPES.has(anchorNodeType)
  );
}

/** The user-facing 'invalid-type' rejection text, owned HERE beside the rule
 *  it describes ({@link isSiblingCompatible}) rather than written out at each
 *  surface. Both the REST route (`api/paragraphs.ts`) and the MCP handler
 *  (`mcp/paragraph-handlers.ts`) render this exact string, and the two cannot
 *  reach each other directly (mcp/ must not import api/ internals), so a
 *  hand-copied message in each was the only alternative — and it had already
 *  drifted: both copies stated only rules 1 and 2 and omitted the tierless-
 *  anchor exception, telling an editor their legal insert after a `note` was
 *  illegal. One definition keeps every surface honest as the rule evolves. */
export function invalidInsertTypeMessage(nodeType: string): string {
  return (
    `node type "${nodeType}" cannot be inserted here — nodeType must match the anchor's ` +
    'own type, or be continuation (legal at any tier); after a tierless anchor (a note or ' +
    'a continuation, neither of which carries a tier) any insertable type is allowed. ' +
    'Parts and notes are never insertable.'
  );
}

/** Insertable-type membership + sibling-compatibility check on the
 *  already-locked, ownership-verified anchor row (spec ownership is checked
 *  upstream in {@link insertSiblingRow}). Factored out to keep the caller's
 *  cyclomatic complexity under the enforced max. Pure — no I/O. */
function resolveInsertableNodeType(
  anchor: AnchorRow,
  input: InsertParagraphInput
): NodeTypeResolution {
  const nodeType = input.nodeType ?? anchor.node_type;
  // A PART has no insertable sibling — the only valid sibling of a part is
  // another part, which is deliberately non-insertable. Guard the anchor type
  // too, else an explicit nodeType (e.g. 'article') slips past the insertable
  // check and lands a non-part node beside the part at parent_id = NULL, which
  // the renderers then mislabel as a PART and round-trip breaks.
  const insertable =
    anchor.node_type !== 'part' && InsertableNodeTypeSchema.safeParse(nodeType).success;
  if (!insertable || !isSiblingCompatible(anchor.node_type, nodeType)) {
    return { ok: false, result: { status: 'invalid-type', nodeType } };
  }
  return { ok: true, nodeType };
}

type ExplicitIdResolution =
  { readonly proceed: true } | { readonly proceed: false; readonly result: InsertParagraphResult };

/** Resolve an `input.explicitId` (the merge added-op apply, #374) against
 *  global DB state, under the anchor `FOR UPDATE` lock already held. The
 *  paragraphs PK is global, so a diff-synthesized uuid may name a row in ANY
 *  spec — the earlier spec-scoped pre-check missed a foreign-spec row and let
 *  the INSERT's `ON CONFLICT DO NOTHING` return no row (surfacing as a 500).
 *  A single global lookup classifies it instead:
 *  - a row in a DIFFERENT spec → `id-collision` (never insertable here);
 *  - a same-spec row with different text → `id-mismatch` (the diff is stale/tampered);
 *  - a same-spec row with matching text → `exists` (an idempotent re-submit, no-op);
 *  - no row → proceed to insert.
 *  Returns `{ proceed: true }` when `explicitId` is unset (the standalone path). */
async function resolveExplicitId(
  client: PoolClient,
  specId: string,
  input: InsertParagraphInput
): Promise<ExplicitIdResolution> {
  const explicitId = input.explicitId;
  if (explicitId === undefined) return { proceed: true };
  const existing = await client.query<{ spec_id: string; text: string }>(
    `SELECT spec_id, text FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [explicitId]
  );
  const row = existing.rows[0];
  if (!row) return { proceed: true };
  // pg lowercases spec_id; z.uuid() preserves an uppercase input — normalize both.
  if (row.spec_id.toLowerCase() !== specId.toLowerCase()) {
    return { proceed: false, result: { status: 'id-collision', ownerSpecId: row.spec_id } };
  }
  if (row.text !== input.text) {
    return { proceed: false, result: { status: 'id-mismatch' } };
  }
  return { proceed: false, result: { status: 'exists', id: explicitId } };
}

/**
 * The reusable DB core behind {@link insertParagraphAfter} and (once wired,
 * #374) the merge engine's added-op apply: lock the anchor, resolve/validate
 * the new sibling's node type, and either short-circuit a retried
 * `input.explicitId` (idempotent — `exists`, no shift or insert runs) or
 * shift later siblings down one position and insert.
 *
 * Deliberately gate-free and bump-free: it never calls `assertSpecWritable`
 * and never touches `specs.content_version` — the caller owns both, exactly
 * once per outer write, not once per sibling inserted (a merge apply of N
 * added-ops must bump the version once, not N times).
 *
 * LOCK ORDER (invariant shared with updateParagraphText and
 * acceptCommentAsNote): the spec row must already be gated/locked by the
 * caller BEFORE this runs — inverting it would let concurrent paragraph write
 * paths deadlock holding one lock each.
 */
export async function insertSiblingRow(
  client: PoolClient,
  specId: string,
  input: InsertParagraphInput
): Promise<InsertParagraphResult> {
  const anchorRes = await client.query<AnchorRow>(
    `SELECT spec_id, parent_id, position, node_type FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [input.anchorNodeId]
  );
  const anchor = anchorRes.rows[0];
  if (!anchor) return { status: 'not-found' };
  // pg lowercases spec_id; z.uuid() preserves an uppercase input — normalize both.
  if (anchor.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };

  // Merge added-op apply only (explicitId set): an orphan carries no tier
  // information, so it can only be placed as a body-tier sibling. A structural
  // anchor (part/article/note) has no safe body-tier inference — reject it as
  // structural-anchor (a documented KNOWN AMBIGUITY, #374) rather than silently
  // cloning the anchor's structural type or aborting the whole merge. The
  // standalone endpoint (no explicitId) still inserts an explicit-typed sibling
  // of any non-part anchor, including article-after-article (#372).
  if (input.explicitId !== undefined && !BODY_TIER_NODE_TYPES.has(anchor.node_type)) {
    return { status: 'structural-anchor', nodeType: anchor.node_type };
  }

  const resolution = resolveInsertableNodeType(anchor, input);
  if (!resolution.ok) return resolution.result;
  const { nodeType } = resolution;

  // The explicitId resolution runs under the SAME anchor FOR UPDATE lock
  // acquired above, and strictly before the sibling-position shift below — a
  // concurrent/retried apply of the same added-op serializes on the anchor lock
  // and observes the first attempt's row before it would otherwise shift
  // positions (or insert) a second time. This is the sole idempotency
  // mechanism; the ON CONFLICT DO NOTHING on the INSERT below is a last-ditch
  // DB-level guard that should never fire in practice.
  const explicit = await resolveExplicitId(client, specId, input);
  if (!explicit.proceed) return explicit.result;

  await client.query(
    `UPDATE paragraphs SET position = position + 1
     WHERE spec_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND position > $3`,
    [anchor.spec_id, anchor.parent_id, anchor.position]
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      input.explicitId ?? null,
      anchor.spec_id,
      anchor.parent_id,
      nodeType,
      input.text,
      anchor.position + 1,
    ]
  );
  const row = inserted.rows[0];
  if (!row) throw new DatabaseError('insertSiblingRow: insert returned no row');

  const node = await fetchSubtreeNode(client, anchor.spec_id, row.id);
  if (!node) throw new DatabaseError('insertSiblingRow: inserted node vanished mid-transaction');
  return { status: 'created', node, parentId: anchor.parent_id, position: anchor.position + 1 };
}

/** In-transaction body of {@link insertParagraphAfter}: gate → delegate the
 *  write to {@link insertSiblingRow} → snapshot the created node's history
 *  (#377, ADR-052 D1) → bump `content_version` once, only on an effective
 *  ('created') write. LOCK ORDER (invariant shared with updateParagraphText
 *  and acceptCommentAsNote): the spec row is gated/locked BEFORE the anchor
 *  paragraph `FOR UPDATE` inside insertSiblingRow — inverting it would let
 *  concurrent paragraph write paths deadlock holding one lock each. */
async function runInsert(
  client: PoolClient,
  specId: string,
  input: InsertParagraphInput
): Promise<StandaloneInsertResult> {
  // The returned contentVersion is the pre-bump generation this write belongs to.
  const gate = await assertSpecWritable(client, specId, input.expectedVersion);

  const result = await insertSiblingRow(client, specId, input);
  if (
    result.status === 'exists' ||
    result.status === 'structural-anchor' ||
    result.status === 'id-collision' ||
    result.status === 'id-mismatch'
  ) {
    // Unreachable: these four statuses require input.explicitId, which the
    // standalone insert never sets. A raw throw keeps the public return type
    // exhaustive (StandaloneInsertResult) rather than leaking a merge-only
    // variant a REST/MCP caller would then have to handle.
    throw new DatabaseError(
      `insertParagraphAfter: unexpected '${result.status}' from a non-explicitId insert`
    );
  }
  if (result.status === 'created') {
    const historyContext = await resolveHistoryContext(
      client,
      gate.contentVersion,
      input.actorLabel
    );
    await recordParagraphHistory(client, {
      paragraphId: result.node.id,
      specId,
      // paragraphs.base_version DEFAULTs to 1 (migration 003) — a freshly
      // inserted row's very first snapshot is always version 1, no read needed.
      version: 1,
      text: result.node.text,
      nodeType: result.node.type,
      op: 'insert',
      contentVersion: historyContext.contentVersion,
      userId: historyContext.userId,
      payload: { kind: 'insert', parentId: result.parentId, position: result.position },
    });
    // A new node is a content write — bump content_version so the next
    // optimistic precondition (and project-copy drift detection) sees it,
    // mirroring updateParagraphText / insertNoteSibling.
    await bumpSpecContentVersion(client, specId);
  }
  return result;
}

/**
 * Insert a new paragraph immediately after `input.anchorNodeId`, as its
 * sibling (same parent), shifting later siblings down one position (#372).
 * The node type defaults to the anchor's own; only body paragraphs, articles,
 * and continuations are insertable — a part or note default is refused. An
 * explicit `nodeType` must additionally be a legal sibling of the anchor
 * (#383, {@link isSiblingCompatible}) — its own tier, `continuation`, or any
 * type when the anchor is TIERLESS (a `note` or a `continuation`, neither of
 * which states a tier to match against) — else the anchor's tier and the new
 * row's tier would disagree (e.g. a `pr1` requested after an `article`
 * anchor).
 *
 * Passes the composed edit gate first (ADR-018): the spec must be writable
 * and, when `expectedVersion` is given, at that version — a stale value
 * throws `StaleVersionError`. Returns the created node as a SpecNode.
 */
export async function insertParagraphAfter(
  specId: string,
  input: InsertParagraphInput
): Promise<StandaloneInsertResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await runInsert(client, specId, input);
    await client.query(result.status === 'created' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('insertParagraphAfter failed', { cause: err });
  } finally {
    client.release();
  }
}
