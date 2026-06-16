import type { PoolClient } from 'pg';
import { MergeError } from './error.js';
import type { DiffResult, ModifiedDiff } from './types.js';

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

function changeIds(diff: DiffResult): ReadonlySet<string> {
  return new Set([
    ...diff.added.map((entry) => entry.uuid),
    ...diff.modified.map((entry) => entry.uuid),
    ...diff.deleted,
    ...diff.conflicts.map((entry) => entry.uuid),
  ]);
}

function applicableChanges(diff: DiffResult): ReadonlyMap<string, ModifiedDiff> {
  return new Map([...diff.modified, ...diff.conflicts].map((entry) => [entry.uuid, entry]));
}

function uniqueAccepted(acceptedIds: readonly string[]): readonly string[] {
  return [...new Set(acceptedIds)];
}

function validateAccepted(
  acceptedIds: readonly string[],
  knownIds: ReadonlySet<string>,
  applicable: ReadonlyMap<string, ModifiedDiff>
): void {
  for (const uuid of acceptedIds) {
    if (!knownIds.has(uuid)) throw new InvalidAcceptedChangeError(`unknown accepted UUID: ${uuid}`);
    if (!applicable.has(uuid)) {
      throw new InvalidAcceptedChangeError(`accepted UUID cannot be applied yet: ${uuid}`);
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

async function applyChange(
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

export async function applyAccepted(
  specId: string,
  acceptedIds: readonly string[],
  diff: DiffResult,
  client: PoolClient
): Promise<ApplyAcceptedResult> {
  const accepted = uniqueAccepted(acceptedIds);
  const knownIds = changeIds(diff);
  const applicable = applicableChanges(diff);
  validateAccepted(accepted, knownIds, applicable);

  let applied = 0;
  for (const uuid of accepted) {
    const change = applicable.get(uuid);
    if (change !== undefined && (await applyChange(specId, change, client))) applied += 1;
  }
  const rejected = knownIds.size - accepted.length;
  return { applied, rejected };
}
