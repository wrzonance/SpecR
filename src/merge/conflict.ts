import type { PoolClient } from 'pg';
import { insertSiblingRow, setVanishRow, recordParagraphHistory } from '../db/index.js';
import type { InsertParagraphResult, ParagraphHistoryContext } from '../db/index.js';
import { MergeError } from './error.js';
import type { DiffResult, ModifiedDiff, ParagraphDiff } from './types.js';

export class InvalidAcceptedChangeError extends MergeError {}

export interface ApplyAcceptedResult {
  readonly applied: number;
  readonly rejected: number;
}

interface ParagraphRow {
  readonly text: string;
  readonly nodeType: string;
  readonly baseVersion: number;
}

// One accepted uuid resolves to exactly one of these four apply strategies —
// 'conflicts' shares the modified/'text' path since it is the same shape
// (ModifiedDiff) and the same ours/theirs apply logic. `diffKind` on the 'text'
// variant records WHICH bucket (modified vs conflict) the entry came from, set
// once here where the origin bucket is still known — applyTextChange has no
// other way to recover it, and the write-history payload (#377, ADR-052 D1)
// needs it to describe the merge. 'object-conflict' (#520) is detection-only:
// it never reaches an apply strategy — validateAccepted rejects every uuid
// resolving to it up front, before the write loop in applyAccepted runs, so
// an atomic object-structural conflict (row/column/kind change on a table or
// text box) can never be partially materialized by accepting one of its
// affected child uuids or the object's own row id.
type ApplicableChange =
  | {
      readonly kind: 'text';
      readonly change: ModifiedDiff;
      readonly diffKind: 'modified' | 'conflict';
    }
  | { readonly kind: 'added'; readonly change: ParagraphDiff }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'object-conflict' };

/** The 'text' branch of {@link ApplicableChange} — applyTextChange's own param
 *  type, so callers narrow once (`change.kind === 'text'`) and pass the whole
 *  entry through rather than unwrapping `.change` and re-threading `diffKind`
 *  as a second parameter. */
type TextChange = Extract<ApplicableChange, { readonly kind: 'text' }>;

// UUIDs are case-insensitive (z.uuid() accepts either case, PostgreSQL's uuid type
// compares canonically), so accept-array and diff-bucket lookups are keyed on a
// case-folded form — otherwise a case-variant accepted uuid is rejected as unknown
// even though it names a real diff entry. Mirrors the DiffResultSchema dedup guard.
const uuidKey = (uuid: string): string => uuid.toLowerCase();

// Every uuid a client could plausibly name for an ObjectConflictDiff: the
// object row's own id (excluded from every other bucket by classifyBase, so
// it appears nowhere else in applicableChanges) and each affected child
// anchor (likewise excluded from modified/deleted/conflicts). Both resolve to
// 'object-conflict' so validateAccepted rejects either with the same clear
// reason rather than the generic "unknown accepted UUID".
function objectConflictEntries(diff: DiffResult): readonly [string, ApplicableChange][] {
  return diff.objectConflicts.flatMap((c): [string, ApplicableChange][] => [
    [uuidKey(c.objectId), { kind: 'object-conflict' }],
    ...c.affectedUuids.map((uuid): [string, ApplicableChange] => [
      uuidKey(uuid),
      { kind: 'object-conflict' },
    ]),
  ]);
}

function applicableChanges(diff: DiffResult): ReadonlyMap<string, ApplicableChange> {
  return new Map<string, ApplicableChange>([
    ...diff.modified.map((c): [string, ApplicableChange] => [
      uuidKey(c.uuid),
      { kind: 'text', change: c, diffKind: 'modified' },
    ]),
    ...diff.conflicts.map((c): [string, ApplicableChange] => [
      uuidKey(c.uuid),
      { kind: 'text', change: c, diffKind: 'conflict' },
    ]),
    ...diff.added.map((c): [string, ApplicableChange] => [
      uuidKey(c.uuid),
      { kind: 'added', change: c },
    ]),
    ...diff.deleted.map((uuid): [string, ApplicableChange] => [uuidKey(uuid), { kind: 'deleted' }]),
    ...objectConflictEntries(diff),
  ]);
}

function uniqueAccepted(acceptedIds: readonly string[]): readonly string[] {
  return [...new Set(acceptedIds.map(uuidKey))];
}

/** Rejects the whole accept call, before any write, if a uuid is unknown OR
 *  names part of an atomic object-structural conflict (#520) — a table/text
 *  box's row/column/kind change cannot be auto-merged by accepting one of its
 *  pieces; the object must be resolved by hand. Runs over every accepted uuid
 *  up front (applyAccepted's write loop starts only after this returns), so
 *  no partial materialization of an object conflict is possible. */
function validateAccepted(
  acceptedIds: readonly string[],
  applicable: ReadonlyMap<string, ApplicableChange>
): void {
  for (const uuid of acceptedIds) {
    const change = applicable.get(uuid);
    if (change === undefined)
      throw new InvalidAcceptedChangeError(`unknown accepted UUID: ${uuid}`);
    if (change.kind === 'object-conflict') {
      throw new InvalidAcceptedChangeError(
        `accepted UUID ${uuid} is part of an atomic object-structural conflict and cannot be ` +
          'auto-merged — resolve the table/text box by hand (KNOWN AMBIGUITY)'
      );
    }
  }
}

async function lockParagraph(
  specId: string,
  paragraphId: string,
  client: PoolClient
): Promise<ParagraphRow | null> {
  const result = await client.query<ParagraphRow>(
    `SELECT text, node_type AS "nodeType", base_version AS "baseVersion"
     FROM paragraphs
     WHERE spec_id = $1 AND id = $2
     FOR UPDATE`,
    [specId, paragraphId]
  );
  return result.rows[0] ?? null;
}

/** Applies one modified/conflict-op text change. Records a paragraph_versions
 *  snapshot (#377, ADR-052 D1) under op 'merge', with a payload naming which
 *  diff bucket (`entry.diffKind`) it resolved — idempotent on
 *  (paragraph_id, version) so a retried apply never duplicates the row.
 *  A no-op (theirs already matches current text) records nothing and never
 *  calls `resolveCtx`, matching applyDeletedChange/applyAddedChange's own
 *  no-op contracts below. */
async function applyTextChange(
  specId: string,
  entry: TextChange,
  client: PoolClient,
  resolveCtx: () => Promise<ParagraphHistoryContext>
): Promise<boolean> {
  const { change, diffKind } = entry;
  const row = await lockParagraph(specId, change.uuid, client);
  if (!row) throw new InvalidAcceptedChangeError(`unknown accepted UUID: ${change.uuid}`);
  if (row.text === change.theirs) return false;
  if (row.text !== change.ours) {
    throw new MergeError(`stale diff for paragraph ${change.uuid}`);
  }
  const nextVersion = row.baseVersion + 1;
  const ctx = await resolveCtx();
  await recordParagraphHistory(client, {
    paragraphId: change.uuid,
    specId,
    version: nextVersion,
    text: change.theirs,
    nodeType: row.nodeType,
    op: 'merge',
    contentVersion: ctx.contentVersion,
    userId: ctx.userId,
    payload: { kind: 'merge', diffKind },
  });
  await client.query(
    `UPDATE paragraphs
     SET text = $1, base_version = $2, updated_at = now()
     WHERE spec_id = $3 AND id = $4`,
    [change.theirs, nextVersion, specId, change.uuid]
  );
  return true;
}

// The subset of InsertParagraphResult that reaching describeInsertFailure implies —
// applyAddedChange has already returned early on 'exists' and 'created'.
type InsertFailure = Exclude<InsertParagraphResult, { status: 'created' } | { status: 'exists' }>;

/** The uuids describeInsertFailure references: the anchor it tried to insert
 *  after, and the addition's own (explicit) id. */
interface InsertFailureContext {
  readonly anchorUuid: string;
  readonly entryUuid: string;
}

function describeInsertFailure(result: InsertFailure, ctx: InsertFailureContext): string {
  switch (result.status) {
    case 'not-found':
      return `added-op anchor not found: ${ctx.anchorUuid}`;
    case 'wrong-spec':
      return `added-op anchor belongs to a different spec: ${ctx.anchorUuid}`;
    case 'invalid-type':
      return `added-op anchor does not accept an insertable sibling (resolved type: ${result.nodeType})`;
    case 'structural-anchor':
      return `added-op anchored on a structural ${result.nodeType} node: an orphan addition carries no tier information and cannot be inserted as its sibling — incorporate it into the master by hand (KNOWN AMBIGUITY)`;
    case 'id-collision':
      return `added-op uuid ${ctx.entryUuid} already exists in a different spec — it cannot be reused as an explicit id here`;
    case 'id-mismatch':
      return `added-op uuid ${ctx.entryUuid} already exists with different text — the diff no longer matches current spec state`;
  }
}

/** Applies one added-op by delegating to insertSiblingRow with `entry.uuid` as
 *  the explicit id — a re-submitted/retried accept resolves to `exists` (no
 *  duplicate row) rather than reapplying. `anchorNodeId` is passed separately
 *  from `entry` so the caller can chain it through the effective-anchor
 *  resolution (see applyAcceptedAdded) rather than always anchoring on
 *  `entry.afterUuid`. Every non-created/non-exists status is a client-visible
 *  rejection (structural/foreign anchor, id collision/mismatch, …) → 400.
 *  On `created`, records a paragraph_versions snapshot (#377, ADR-052 D1)
 *  under op 'merge' — closing the gap #374 left open, where an added-op's
 *  materialization recorded no write-history at all. `version` is always 1:
 *  insertSiblingRow's INSERT never sets base_version explicitly, so the new
 *  row carries paragraphs.base_version's column DEFAULT (1, migration 003) —
 *  no extra read needed to know it. An `exists` (idempotent re-submit)
 *  snapshots nothing and never calls `resolveCtx`, matching
 *  applyTextChange/applyDeletedChange's own no-op contracts. */
async function applyAddedChange(
  specId: string,
  anchorNodeId: string,
  entry: ParagraphDiff,
  client: PoolClient,
  resolveCtx: () => Promise<ParagraphHistoryContext>
): Promise<boolean> {
  const result = await insertSiblingRow(client, specId, {
    anchorNodeId,
    text: entry.text,
    explicitId: entry.uuid,
  });
  if (result.status === 'exists') return false;
  if (result.status === 'created') {
    const ctx = await resolveCtx();
    await recordParagraphHistory(client, {
      paragraphId: result.node.id,
      specId,
      version: 1,
      text: result.node.text,
      nodeType: result.node.type,
      op: 'merge',
      contentVersion: ctx.contentVersion,
      userId: ctx.userId,
      payload: { kind: 'merge', diffKind: 'added' },
    });
    return true;
  }
  throw new InvalidAcceptedChangeError(
    describeInsertFailure(result, { anchorUuid: anchorNodeId, entryUuid: entry.uuid })
  );
}

function sortedAcceptedAdded(entries: readonly ParagraphDiff[]): readonly ParagraphDiff[] {
  return [...entries].sort((a, b) => a.index - b.index);
}

/** Group every diff.added entry by its afterUuid anchor, each group sorted by
 *  ascending index — so an entry can find which same-anchor siblings precede it
 *  in document order, INCLUDING ones accepted in an earlier /merge call. Built
 *  from the full diff.added (not just this call's accepted entries), since the
 *  preceding sibling may have been applied and not re-accepted this call. */
function groupAddedByAnchor(
  allAdded: readonly ParagraphDiff[]
): ReadonlyMap<string, readonly ParagraphDiff[]> {
  const groups = new Map<string, ParagraphDiff[]>();
  for (const entry of allAdded) {
    if (entry.afterUuid === undefined) continue;
    const bucket = groups.get(entry.afterUuid) ?? [];
    bucket.push(entry);
    groups.set(entry.afterUuid, bucket);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => a.index - b.index);
  return groups;
}

/** Resolve the effective anchor `entry` inserts after, so siblings land in
 *  diff.index order even when accepted across SEPARATE /merge calls (openapi
 *  documents re-submission as a no-op, so a split accept must not invert
 *  order). Among same-anchor entries with a LOWER index, the effective anchor
 *  is the highest-index one already present in the spec — a prior call's insert
 *  or one made earlier in THIS call, both visible on this transaction's own
 *  connection; failing that the in-call remap; failing that the original
 *  afterUuid. */
async function resolveEffectiveAnchor(
  specId: string,
  entry: ParagraphDiff,
  afterUuid: string,
  groups: ReadonlyMap<string, readonly ParagraphDiff[]>,
  remap: ReadonlyMap<string, string>,
  client: PoolClient
): Promise<string> {
  const priorSiblings = (groups.get(afterUuid) ?? []).filter((s) => s.index < entry.index);
  if (priorSiblings.length > 0) {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM paragraphs WHERE spec_id = $1 AND id = ANY($2)`,
      [specId, priorSiblings.map((s) => s.uuid)]
    );
    const present = new Set(res.rows.map((r) => r.id.toLowerCase()));
    // priorSiblings is index-ascending → the last present one is the highest index.
    const highest = priorSiblings.filter((s) => present.has(s.uuid.toLowerCase())).at(-1);
    if (highest) return highest.uuid;
  }
  return remap.get(afterUuid) ?? afterUuid;
}

/** Applies every accepted added-op in diff.index order (document order),
 *  regardless of the order uuids appear in the accept array — sibling
 *  added-ops anchored on the same original uuid must land in that order, not
 *  accept-array order. `resolveEffectiveAnchor` chains each entry off its
 *  nearest already-materialized same-anchor sibling (in this call OR a prior
 *  one); the in-call remap is seeded on both created AND exists so a later
 *  same-call sibling still chains off an idempotent re-submit. */
async function applyAcceptedAdded(
  specId: string,
  acceptedEntries: readonly ParagraphDiff[],
  allAdded: readonly ParagraphDiff[],
  client: PoolClient,
  resolveCtx: () => Promise<ParagraphHistoryContext>
): Promise<number> {
  const groups = groupAddedByAnchor(allAdded);
  const remap = new Map<string, string>();
  let applied = 0;
  for (const entry of sortedAcceptedAdded(acceptedEntries)) {
    if (entry.afterUuid === undefined) {
      throw new InvalidAcceptedChangeError(`added-op ${entry.uuid} has no anchor to insert after`);
    }
    const anchorNodeId = await resolveEffectiveAnchor(
      specId,
      entry,
      entry.afterUuid,
      groups,
      remap,
      client
    );
    const created = await applyAddedChange(specId, anchorNodeId, entry, client, resolveCtx);
    remap.set(entry.afterUuid, entry.uuid);
    if (created) applied += 1;
  }
  return applied;
}

/** Applies one deleted-op by delegating to setVanishRow(..., true) — never a
 *  hard delete. Uses the pre-toggle image setVanishRow returns to snapshot
 *  the paragraph_versions row (#377, ADR-052 D1) under op 'merge' without a
 *  second FOR UPDATE round-trip. */
async function applyDeletedChange(
  specId: string,
  uuid: string,
  client: PoolClient,
  resolveCtx: () => Promise<ParagraphHistoryContext>
): Promise<boolean> {
  const result = await setVanishRow(client, specId, uuid, true);
  if (result.status === 'not-removable') {
    throw new InvalidAcceptedChangeError(
      `deleted-op targets a non-removable node type: ${result.nodeType}`
    );
  }
  if (result.status === 'not-found' || result.status === 'wrong-spec') {
    // Defensive — validateAccepted already confirmed uuid ∈ diff.deleted, so
    // this is unreachable in practice, but must not fail silently.
    throw new InvalidAcceptedChangeError(`unknown accepted UUID: ${uuid}`);
  }
  if (!result.changed) return false;

  const nextVersion = result.previousBaseVersion + 1;
  const ctx = await resolveCtx();
  await recordParagraphHistory(client, {
    paragraphId: uuid,
    specId,
    version: nextVersion,
    text: result.previousText,
    nodeType: result.previousNodeType,
    op: 'merge',
    contentVersion: ctx.contentVersion,
    userId: ctx.userId,
    payload: { kind: 'merge', diffKind: 'deleted' },
  });
  return true;
}

/**
 * Applies every accepted uuid's change inside the caller's already-open
 * transaction (#374 adds added/deleted-op support to the original
 * modified/conflict apply, #ADR-009). Text changes (modified/conflicts) and
 * deleted-ops apply inline, in accept-array order; added-ops are collected
 * and applied afterward in diff.index order via applyAcceptedAdded — sibling
 * order must follow document order, not caller-supplied order. Any thrown
 * error propagates to the caller uncaught, so the whole apply is atomic: the
 * caller's transaction rolls back every write this call made.
 *
 * `resolveCtx` (#377, ADR-052 D1) is a memoized {@link ParagraphHistoryContext}
 * resolver built once by the caller (see apply-merge.ts's lazyHistoryContext)
 * and threaded to every apply-strategy function, each of which calls it only
 * once it has confirmed ITS OWN change is effective — never on a no-op. That
 * keeps the actor-upsert (resolveOrCreateUserByLabel, inside
 * resolveHistoryContext) off the path entirely for a merge that ends up
 * writing nothing, while still sharing one content_version generation and one
 * resolved actor across every snapshot N effective changes from one outer
 * write DO make (the resolver caches its result after the first call).
 */
export async function applyAccepted(
  specId: string,
  acceptedIds: readonly string[],
  diff: DiffResult,
  client: PoolClient,
  resolveCtx: () => Promise<ParagraphHistoryContext>
): Promise<ApplyAcceptedResult> {
  const accepted = uniqueAccepted(acceptedIds);
  const applicable = applicableChanges(diff);
  validateAccepted(accepted, applicable);

  const addedEntries: ParagraphDiff[] = [];
  let applied = 0;
  for (const uuid of accepted) {
    const change = applicable.get(uuid);
    if (change === undefined) continue; // unreachable: validateAccepted confirmed membership
    if (change.kind === 'added') {
      addedEntries.push(change.change);
      continue;
    }
    const wasApplied =
      change.kind === 'text'
        ? await applyTextChange(specId, change, client, resolveCtx)
        : await applyDeletedChange(specId, uuid, client, resolveCtx);
    if (wasApplied) applied += 1;
  }
  applied += await applyAcceptedAdded(specId, addedEntries, diff.added, client, resolveCtx);

  return { applied, rejected: applicable.size - accepted.length };
}
