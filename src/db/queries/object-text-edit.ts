// DB orchestration for editing an `objectText` child paragraph (#519, ADR-072
// decision 3 follow-on). SpecR never stores that paragraph's text on its own
// `paragraphs` row — only a locator (the row's own id, the SAME uuid baked
// into the `w:sdt` merge anchor) into its parent `object` row's
// `object_data.blob` (parser/docx/object-blob-edit.ts). Rewriting the text
// therefore means: lock the parent row, find-and-replace inside its blob,
// re-persist the whole blob — never a direct UPDATE on the child row.

import type { PoolClient } from 'pg';
import { DatabaseError } from '../index.js';
import { replaceAnchoredParagraphText } from '../../parser/index.js';
import { parseObjectMeta, updateObjectData } from './object-meta.js';

/**
 * Rewrite the text of the interior paragraph anchored by `anchorUuid` inside
 * `parentId`'s captured object blob, inside the caller's already-open
 * transaction (mirrors `bumpSpecContentVersion`'s gate-free `PoolClient`
 * shape — no BEGIN/COMMIT here, the caller owns the transaction boundary).
 *
 * `SELECT ... FOR UPDATE` locks the parent `object` row for the rest of the
 * transaction, so two concurrent edits targeting two DIFFERENT anchors
 * inside the SAME object row's blob serialize onto one read-modify-write
 * instead of racing a lost update onto the single JSONB column both edits
 * share — the second writer's SELECT blocks until the first COMMITs (or
 * ROLLBACKs), then reads the first writer's already-applied change.
 *
 * Throws `DatabaseError` when `parentId` does not resolve to an `object` row
 * in `specId`, or when `anchorUuid` is not anchored anywhere in that row's
 * blob — both are caller-contract violations (the paragraphs.ts write path
 * resolves both from an already-verified `objectText` row before calling
 * this), never a silent no-op.
 */
export async function rewriteObjectTextBlob(
  client: PoolClient,
  specId: string,
  parentId: string,
  anchorUuid: string,
  newText: string
): Promise<void> {
  try {
    const owner = await client.query<{ object_data: unknown }>(
      `SELECT object_data FROM paragraphs
       WHERE id = $1 AND spec_id = $2 AND node_type = 'object'
       FOR UPDATE`,
      [parentId, specId]
    );
    const found = owner.rows[0];
    if (!found) {
      throw new DatabaseError(
        `rewriteObjectTextBlob: no object row ${parentId} found in spec ${specId}`
      );
    }

    const meta = parseObjectMeta('object', found.object_data, 'rewriteObjectTextBlob');
    // parseObjectMeta only returns undefined for a non-'object' nodeType; the
    // SELECT above already scoped to node_type = 'object', so this branch is
    // unreachable in practice (a real miss throws inside parseObjectMeta
    // itself) — kept only to satisfy the ObjectMeta | undefined return type.
    if (!meta) {
      throw new DatabaseError(
        `rewriteObjectTextBlob: object row ${parentId} unexpectedly carries no captured object data`
      );
    }

    // #650 — the SAME resolved character-style-id set capture consulted
    // (persisted on the object row itself as ObjectMeta.vanishCharStyleIds,
    // since styles.xml is unavailable here at rewrite time) so a run capture
    // skipped as w:rStyle-hidden is skipped by the rewrite walk too. `?? []`
    // covers a pre-#650 backfill row that carries no such key at all —
    // identical to today's unchanged behaviour (no run treated as hidden by
    // style).
    const vanishCharStyleIds = new Set(meta.vanishCharStyleIds ?? []);
    const newBlob = replaceAnchoredParagraphText(
      meta.blob,
      anchorUuid,
      newText,
      vanishCharStyleIds
    );
    if (!newBlob) {
      throw new DatabaseError(
        `rewriteObjectTextBlob: anchor ${anchorUuid} not found in object ${parentId}'s blob`
      );
    }

    // Spread-copy readonly -> mutable at this ONE boundary: replaceAnchoredParagraphText's
    // own contract stays readonly and side-effect-free (WS3b's merge engine needs that),
    // so the conversion back to ObjectMeta.blob's mutable-array shape happens here, not there.
    await updateObjectData(client, specId, parentId, { ...meta, blob: [...newBlob] });
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `rewriteObjectTextBlob: failed to rewrite object ${parentId}'s blob at anchor ${anchorUuid}`,
      { cause: err }
    );
  }
}
