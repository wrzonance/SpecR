import { pool, DatabaseError } from '../index.js';
import { setEditabilityOverride, clearEditabilityOverride } from './editability.js';
import type { Editability } from '../../ast/index.js';

/** Ownership-checked outcome: the (specId, nodeId) pairing is verified before any
 *  write so the API maps `not-found` → 404 and `wrong-spec` → 403 (mirrors
 *  updateParagraphText). `ok` means the write was applied. */
export type OwnershipResult =
  | { readonly status: 'ok' }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' };

// Verify a paragraph belongs to the spec. Returns the non-'ok' outcome to short
// out the caller, or null when ownership holds and the write may proceed.
async function checkOwnership(
  specId: string,
  nodeId: string
): Promise<Exclude<OwnershipResult, { status: 'ok' }> | null> {
  const owner = await pool.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1`,
    [nodeId]
  );
  const row = owner.rows[0];
  if (!row) return { status: 'not-found' };
  if (row.spec_id !== specId) return { status: 'wrong-spec' };
  return null;
}

export async function setSpecEditabilityOverride(
  specId: string,
  nodeId: string,
  editability: Editability
): Promise<OwnershipResult> {
  try {
    const bad = await checkOwnership(specId, nodeId);
    if (bad) return bad;
    await setEditabilityOverride(nodeId, editability);
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('setSpecEditabilityOverride failed', { cause: err });
  }
}

export async function clearSpecEditabilityOverride(
  specId: string,
  nodeId: string
): Promise<OwnershipResult> {
  try {
    const bad = await checkOwnership(specId, nodeId);
    if (bad) return bad;
    await clearEditabilityOverride(nodeId);
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('clearSpecEditabilityOverride failed', { cause: err });
  }
}
