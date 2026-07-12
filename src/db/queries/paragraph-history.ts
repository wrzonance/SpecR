import type { PoolClient } from 'pg';
import { DatabaseError } from '../index.js';
import { resolveOrCreateUserByLabel } from './users.js';

// ADR-052 D1 (#377) — the write-history capture core. Every content-mutating
// write path (edit, insert, remove/restore, merge-apply, accept-as-note) calls
// recordParagraphHistory exactly once per paragraph it touches, inside the same
// transaction as the mutation itself, so a version row is self-describing
// without joining back through paragraphs/specs.
//
// PARAGRAPH_HISTORY_OPS mirrors migration 046's `paragraph_versions_op_check`
// CHECK constraint. Migrations are frozen snapshots (never imported into
// runtime src/), so this is a deliberately duplicated literal — keep the two
// in lockstep by hand when the enum changes.
export const PARAGRAPH_HISTORY_OPS = [
  'edit',
  'insert',
  'remove',
  'restore',
  'merge',
  'accept-note',
  'restructure',
] as const;

export type ParagraphHistoryOp = (typeof PARAGRAPH_HISTORY_OPS)[number];

/** Structural ops record a small delta describing what changed; edit/remove/
 *  restore have no structural delta to record and always pass `null`. */
export type ParagraphHistoryPayload =
  | { readonly kind: 'insert'; readonly parentId: string | null; readonly position: number }
  | { readonly kind: 'merge'; readonly diffKind: 'modified' | 'conflict' | 'added' | 'deleted' }
  | { readonly kind: 'accept-note'; readonly anchorNodeId: string; readonly commentIndex: number }
  | null;

/** Always the paragraph's POST-write state (text/nodeType/version) — mirrors
 *  the pre-existing `v.version = p.base_version` join invariant in
 *  versions.ts's getParagraphSnapshots, so a history row can double as a base
 *  snapshot for the 3-way merge exactly as today's rows do. */
export interface RecordParagraphHistoryInput {
  readonly paragraphId: string;
  readonly specId: string;
  readonly version: number;
  readonly text: string;
  readonly nodeType: string;
  readonly op: ParagraphHistoryOp;
  readonly contentVersion: number;
  readonly userId: string;
  readonly payload?: ParagraphHistoryPayload;
}

/** The two values every recordParagraphHistory call within one outer write
 *  shares: the post-bump content_version generation and the resolved actor.
 *  Resolved once per outer write via {@link resolveHistoryContext} and
 *  threaded to every paragraph snapshot that write's transaction touches. */
export interface ParagraphHistoryContext {
  readonly contentVersion: number;
  readonly userId: string;
}

/** Sentinel actor label for writes that supply no `actorLabel`. Resolved
 *  through the same resolveOrCreateUserByLabel upsert as any real label, so
 *  every row this module writes has a real users.id behind user_id — never a
 *  bare null at the app layer, even though the column itself stays nullable
 *  (migration 046) for the historical rows it can't backfill. */
export const SYSTEM_ACTOR_LABEL = 'system:unattributed';

/**
 * Snapshot one paragraph_versions row inside the caller's already-open
 * transaction. Idempotent on (paragraph_id, version) — ON CONFLICT DO
 * NOTHING — so a retried write never duplicates or clobbers a prior snapshot;
 * this supersedes the shim `snapshotParagraphVersion` in merge/conflict.ts,
 * which the #377 wiring tasks retire. Never mutates `input`.
 */
export async function recordParagraphHistory(
  client: PoolClient,
  input: RecordParagraphHistoryInput
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO paragraph_versions
         (paragraph_id, spec_id, version, text, node_type, op, content_version, user_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (paragraph_id, version) DO NOTHING`,
      [
        input.paragraphId,
        input.specId,
        input.version,
        input.text,
        input.nodeType,
        input.op,
        input.contentVersion,
        input.userId,
        JSON.stringify(input.payload ?? null),
      ]
    );
  } catch (err) {
    throw new DatabaseError('recordParagraphHistory failed', { cause: err });
  }
}

/** Resolve `actorLabel` to a real users.id, falling back to
 *  {@link SYSTEM_ACTOR_LABEL} when the caller supplied none — so a write with
 *  no attributed actor still resolves to a real row rather than leaving the
 *  FK unresolved. Runs on the caller's transaction client (resolveOrCreateUserByLabel
 *  accepts any Queryable, including a PoolClient). */
export async function resolveActorUserId(
  client: PoolClient,
  actorLabel: string | undefined
): Promise<string> {
  const user = await resolveOrCreateUserByLabel(actorLabel ?? SYSTEM_ACTOR_LABEL, client);
  return user.id;
}

/**
 * Resolve the two cross-cutting values one outer write's history rows share.
 * `preBumpContentVersion` is the `content_version` assertSpecWritable's gate
 * read BEFORE this write's bump — the returned `contentVersion` is that value
 * + 1, matching the value `specs.content_version` will hold once the caller's
 * paired `bumpSpecContentVersion` call commits. Call this exactly once per
 * outer write, immediately after the gate succeeds, and thread the result to
 * every recordParagraphHistory call in that transaction.
 */
export async function resolveHistoryContext(
  client: PoolClient,
  preBumpContentVersion: number,
  actorLabel: string | undefined
): Promise<ParagraphHistoryContext> {
  const userId = await resolveActorUserId(client, actorLabel);
  return { contentVersion: preBumpContentVersion + 1, userId };
}
