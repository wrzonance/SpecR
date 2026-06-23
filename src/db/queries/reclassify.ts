import { pool, DatabaseError } from '../index.js';
import { setEditabilityOverride, clearEditabilityOverride } from './editability.js';
import { ClassificationSchema, OverrideSchema } from './editability.js';
import { getSpecTree } from './specs.js';
import { getConventionForLibrary } from './conventions.js';
import { storeClassifications } from './editability.js';
import { classify } from '../../conventions/index.js';
import type { ConventionRules, Editability } from '../../ast/index.js';
import type { ClassifyResult } from '../../conventions/index.js';

/** Ownership-checked outcome: the (specId, nodeId) pairing is verified before any
 *  write so the API maps `not-found` → 404 and `wrong-spec` → 403 (mirrors
 *  updateParagraphText). `ok` means the write was applied. */
export type OwnershipResult =
  | { readonly status: 'ok' }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' };

export interface EditabilityDiffEntry {
  readonly nodeId: string;
  /** Machine classification BEFORE this pass (null = was unclassified). */
  readonly before: Editability | null;
  /** Fresh machine verdict from this pass. */
  readonly after: Editability;
  /** A standing human override now disagrees with the fresh verdict (ADR-022 D2). */
  readonly overrideDisagrees: boolean;
}

export interface ReclassifyReport {
  readonly specId: string;
  /** false on a preview pass (diff computed, nothing written). */
  readonly persisted: boolean;
  readonly total: number;
  readonly changed: number;
  readonly entries: readonly EditabilityDiffEntry[];
}

export type ReclassifyOutcome =
  | { readonly status: 'ok'; readonly report: ReclassifyReport }
  | { readonly status: 'not-found' }
  | { readonly status: 'no-convention' };

interface PriorState {
  readonly machineBefore: Map<string, Editability | null>;
  readonly overrides: Map<string, Editability>;
}

// Read the pre-reclassify machine classification and override for every paragraph
// in the spec. `machineBefore` maps nodeId → machine editability (null if not yet
// classified). `overrides` maps nodeId → human override editability (absent when none).
async function readPriorState(specId: string): Promise<PriorState> {
  const result = await pool.query<{
    id: string;
    classification: unknown;
    editability_override: unknown;
  }>(`SELECT id, classification, editability_override FROM paragraphs WHERE spec_id = $1`, [
    specId,
  ]);
  const machineBefore = new Map<string, Editability | null>();
  const overrides = new Map<string, Editability>();
  for (const row of result.rows) {
    const machine =
      row.classification === null || row.classification === undefined
        ? null
        : ClassificationSchema.parse(row.classification).editability;
    machineBefore.set(row.id, machine);
    if (row.editability_override !== null && row.editability_override !== undefined) {
      overrides.set(row.id, OverrideSchema.parse(row.editability_override).editability);
    }
  }
  return { machineBefore, overrides };
}

// Build one diff entry per classified node from the fresh verdict and the pre-pass maps.
function buildDiff(prior: PriorState, fresh: ClassifyResult): EditabilityDiffEntry[] {
  return fresh.map(({ nodeId, editability: after }) => {
    const before = prior.machineBefore.get(nodeId) ?? null;
    const override = prior.overrides.get(nodeId);
    return {
      nodeId,
      before,
      after,
      overrideDisagrees: override !== undefined && override !== after,
    };
  });
}

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

async function resolveRules(
  specId: string,
  opts: { rules?: ConventionRules }
): Promise<ConventionRules | null> {
  if (opts.rules !== undefined) return opts.rules;
  const lib = await pool.query<{ library_id: string | null }>(
    `SELECT library_id FROM specs WHERE id = $1`,
    [specId]
  );
  const libraryId = lib.rows[0]?.library_id;
  if (!libraryId) return null;
  const convention = await getConventionForLibrary(libraryId);
  return convention ? convention.rules : null;
}

export async function reclassifySpec(
  specId: string,
  opts: { rules?: ConventionRules; preview?: boolean }
): Promise<ReclassifyOutcome> {
  try {
    const treeResult = await getSpecTree(specId);
    if (!treeResult) return { status: 'not-found' };
    const rules = await resolveRules(specId, opts);
    if (rules === null) return { status: 'no-convention' };

    // Read machine classifications + overrides BEFORE persisting the fresh pass.
    const prior = await readPriorState(specId);
    const fresh = classify(treeResult.tree, rules);
    const entries = buildDiff(prior, fresh);
    const changed = entries.filter((e) => e.before !== e.after).length;

    const persisted = opts.preview !== true;
    if (persisted) await storeClassifications(specId, fresh);

    return {
      status: 'ok',
      report: { specId, persisted, total: entries.length, changed, entries },
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('reclassifySpec failed', { cause: err });
  }
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
