import type { PoolClient } from 'pg';
import { insertSiblingRow, setVanishRow } from '../db/index.js';
import type { InsertParagraphResult } from '../db/index.js';
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

// One accepted uuid resolves to exactly one of these three apply strategies —
// 'conflicts' shares the modified/'text' path since it is the same shape
// (ModifiedDiff) and the same ours/theirs apply logic.
type ApplicableChange =
  | { readonly kind: 'text'; readonly change: ModifiedDiff }
  | { readonly kind: 'added'; readonly change: ParagraphDiff }
  | { readonly kind: 'deleted' };

function applicableChanges(diff: DiffResult): ReadonlyMap<string, ApplicableChange> {
  return new Map<string, ApplicableChange>([
    ...diff.modified.map((c): [string, ApplicableChange] => [c.uuid, { kind: 'text', change: c }]),
    ...diff.conflicts.map((c): [string, ApplicableChange] => [c.uuid, { kind: 'text', change: c }]),
    ...diff.added.map((c): [string, ApplicableChange] => [c.uuid, { kind: 'added', change: c }]),
    ...diff.deleted.map((uuid): [string, ApplicableChange] => [uuid, { kind: 'deleted' }]),
  ]);
}

function uniqueAccepted(acceptedIds: readonly string[]): readonly string[] {
  return [...new Set(acceptedIds)];
}

function validateAccepted(
  acceptedIds: readonly string[],
  applicable: ReadonlyMap<string, ApplicableChange>
): void {
  for (const uuid of acceptedIds) {
    if (!applicable.has(uuid))
      throw new InvalidAcceptedChangeError(`unknown accepted UUID: ${uuid}`);
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

async function applyTextChange(
  specId: string,
  change: ModifiedDiff,
  client: PoolClient
): Promise<boolean> {
  const row = await lockParagraph(specId, change.uuid, client);
  if (!row) throw new InvalidAcceptedChangeError(`unknown accepted UUID: ${change.uuid}`);
  if (row.text === change.theirs) return false;
  if (row.text !== change.ours) {
    throw new MergeError(`stale diff for paragraph ${change.uuid}`);
  }
  const nextVersion = row.baseVersion + 1;
  await client.query(
    `INSERT INTO paragraph_versions (paragraph_id, version, text, node_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (paragraph_id, version) DO NOTHING`,
    [change.uuid, nextVersion, change.theirs, row.nodeType]
  );
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

function describeInsertFailure(anchorUuid: string, result: InsertFailure): string {
  switch (result.status) {
    case 'not-found':
      return `added-op anchor not found: ${anchorUuid}`;
    case 'wrong-spec':
      return `added-op anchor belongs to a different spec: ${anchorUuid}`;
    case 'invalid-type':
      return `added-op anchor does not accept an insertable sibling (resolved type: ${result.nodeType})`;
  }
}

/** Applies one added-op by delegating to insertSiblingRow with `entry.uuid` as
 *  the explicit id — a re-submitted/retried accept resolves to `exists` (no
 *  duplicate row) rather than reapplying. `anchorNodeId` is passed separately
 *  from `entry` so the caller can chain it through a remap (see
 *  applyAcceptedAdded) rather than always anchoring on `entry.afterUuid`. */
async function applyAddedChange(
  specId: string,
  anchorNodeId: string,
  entry: ParagraphDiff,
  client: PoolClient
): Promise<boolean> {
  const result = await insertSiblingRow(client, specId, {
    anchorNodeId,
    text: entry.text,
    explicitId: entry.uuid,
  });
  if (result.status === 'exists') return false;
  if (result.status === 'created') return true;
  throw new InvalidAcceptedChangeError(describeInsertFailure(anchorNodeId, result));
}

function sortedAcceptedAdded(entries: readonly ParagraphDiff[]): readonly ParagraphDiff[] {
  return [...entries].sort((a, b) => a.index - b.index);
}

/** Applies every accepted added-op in diff.index order (document order),
 *  regardless of the order uuids appear in the accept array — sibling
 *  added-ops anchored on the same original uuid must land in that order, not
 *  accept-array order. A function-local remap chains each successfully
 *  inserted entry's own uuid in for its original anchor, so a second orphan
 *  sharing that anchor inserts after the first rather than both landing
 *  immediately after the same pre-existing paragraph (which would reverse
 *  their order). */
async function applyAcceptedAdded(
  specId: string,
  entries: readonly ParagraphDiff[],
  client: PoolClient
): Promise<number> {
  const remap = new Map<string, string>();
  let applied = 0;
  for (const entry of sortedAcceptedAdded(entries)) {
    if (entry.afterUuid === undefined) {
      throw new InvalidAcceptedChangeError(`added-op ${entry.uuid} has no anchor to insert after`);
    }
    const anchorNodeId = remap.get(entry.afterUuid) ?? entry.afterUuid;
    if (await applyAddedChange(specId, anchorNodeId, entry, client)) {
      remap.set(entry.afterUuid, entry.uuid);
      applied += 1;
    }
  }
  return applied;
}

/** Applies one deleted-op by delegating to setVanishRow(..., true) — never a
 *  hard delete. Uses the pre-toggle image setVanishRow returns to snapshot
 *  the paragraph_versions row without a second FOR UPDATE round-trip. */
async function applyDeletedChange(
  specId: string,
  uuid: string,
  client: PoolClient
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
  await client.query(
    `INSERT INTO paragraph_versions (paragraph_id, version, text, node_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (paragraph_id, version) DO NOTHING`,
    [uuid, nextVersion, result.previousText, result.previousNodeType]
  );
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
 */
export async function applyAccepted(
  specId: string,
  acceptedIds: readonly string[],
  diff: DiffResult,
  client: PoolClient
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
        ? await applyTextChange(specId, change.change, client)
        : await applyDeletedChange(specId, uuid, client);
    if (wasApplied) applied += 1;
  }
  applied += await applyAcceptedAdded(specId, addedEntries, client);

  return { applied, rejected: applicable.size - accepted.length };
}
