import { pool, DatabaseError } from '../index.js';
import {
  setEditabilityOverride,
  clearEditabilityOverride,
  ClassificationSchema,
  OverrideSchema,
  storeClassifications,
} from './editability.js';
import { getSpecTree } from './specs.js';
import {
  getConventionForLibrary,
  getBuiltInConvention,
  ConventionValidationError,
} from './conventions.js';
import { checkRegexPatterns } from '../../lib/regex-safety.js';
import { classify } from '../../conventions/index.js';
import { assertSpecWritable } from './edit-gate.js';
import { SourceFactsSchema } from '../../ast/index.js';
import type { PoolClient } from 'pg';
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

// Request-supplied rules carry user regexes (noteBanners) that bypass the
// convention CRUD write boundary, so bound them here exactly as
// upsertLibraryConvention does — an unsafe pattern must be rejected before
// classify() ever runs it over the document (ADR-022 D5, ReDoS guard).
function validateRequestRules(rules: ConventionRules): ConventionRules {
  const safety = checkRegexPatterns(rules.noteBanners ?? []);
  if (!safety.safe) {
    throw new ConventionValidationError(`unsafe noteBanners regex: ${safety.reason}`);
  }
  return rules;
}

async function resolveRules(
  specId: string,
  opts: { rules?: ConventionRules }
): Promise<ConventionRules | null> {
  // Library-resolved rules were already bounded at write time; only
  // request-supplied rules need validation here.
  if (opts.rules !== undefined) return validateRequestRules(opts.rules);
  const lib = await pool.query<{ library_id: string | null }>(
    `SELECT library_id FROM specs WHERE id = $1`,
    [specId]
  );
  const libraryId = lib.rows[0]?.library_id;
  // Library specs resolve their profile (which itself falls back to the built-in
  // default); project working copies own by project_id and have library_id NULL,
  // so they resolve straight to the built-in default. Either way classification
  // is "library profile OR built-in default" (ADR-022 D3 / #132) — never null
  // just because there is no library convention.
  const convention = libraryId
    ? await getConventionForLibrary(libraryId)
    : await getBuiltInConvention();
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

// ── acceptCommentAsNote ────────────────────────────────────────────────────

export type AcceptNoteOutcome =
  | { readonly status: 'created'; readonly noteId: string }
  | { readonly status: 'already-accepted'; readonly noteId: string }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'no-comment' };

interface AnchorRow {
  readonly spec_id: string;
  readonly parent_id: string | null;
  readonly position: number;
  readonly source_facts: unknown;
}

function commentTextAt(sourceFacts: unknown, index: number): string | null {
  const facts = SourceFactsSchema.parse(sourceFacts);
  const comment = facts.comments?.[index];
  return comment ? comment.text : null;
}

// The materialized note for a given (anchor, index), matched on provenance
// alone — `anchorNodeId` is a globally-unique paragraph PK, so it identifies the
// note without the parent_id and without locking the anchor. This is the
// fast/no-op path: an already-accepted comment writes nothing, so it must not
// require writability. The in-lock `findExistingNote` below stays the
// authoritative race check on the write path.
async function findExistingNoteByProvenance(
  client: PoolClient,
  anchorId: string,
  index: number
): Promise<string | null> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM paragraphs
     WHERE node_type = 'note'
       AND source_facts #> '{acceptedComment}' = $1::jsonb`,
    [JSON.stringify({ anchorNodeId: anchorId, index })]
  );
  return existing.rows[0]?.id ?? null;
}

async function findExistingNote(
  client: PoolClient,
  parentId: string | null,
  anchorId: string,
  index: number
): Promise<string | null> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM paragraphs
     WHERE node_type = 'note'
       AND parent_id IS NOT DISTINCT FROM $1
       AND source_facts #> '{acceptedComment}' = $2::jsonb`,
    [parentId, JSON.stringify({ anchorNodeId: anchorId, index })]
  );
  return existing.rows[0]?.id ?? null;
}

async function insertNoteSibling(
  client: PoolClient,
  anchor: AnchorRow,
  specId: string,
  anchorId: string,
  index: number,
  text: string
): Promise<string> {
  await client.query(
    `UPDATE paragraphs SET position = position + 1
     WHERE spec_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND position > $3`,
    [specId, anchor.parent_id, anchor.position]
  );
  const facts = JSON.stringify({ acceptedComment: { anchorNodeId: anchorId, index } });
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, source_facts)
     VALUES ($1, $2, 'note', $3, $4, $5::jsonb) RETURNING id`,
    [specId, anchor.parent_id, text, anchor.position + 1, facts]
  );
  const row = inserted.rows[0];
  if (!row) throw new DatabaseError('acceptCommentAsNote: insert returned no row');
  // Materializing a note mutates the tree — bump content_version so project-copy
  // clean/edited detection (which keys on it) sees the change (mirrors
  // updateParagraphText). The idempotent repeat path rolls back, so it never reaches here.
  await client.query(
    `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
    [specId]
  );
  return row.id;
}

async function runAccept(
  client: PoolClient,
  specId: string,
  nodeId: string,
  index: number
): Promise<AcceptNoteOutcome> {
  // Ownership gate (non-locking) BEFORE the fast path: a wrong (specId, nodeId)
  // pair must surface as not-found/wrong-spec, never an 'already-accepted' +
  // noteId that leaks the existence/id of a note the caller does not own. The
  // plain SELECT takes no lock, so it stays off the write path's lock order.
  const owner = await client.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1`,
    [nodeId]
  );
  const owned = owner.rows[0];
  if (!owned) return { status: 'not-found' };
  // Case-insensitive: z.uuid() accepts uppercase, Postgres returns lowercase —
  // normalize both sides so a valid uppercase specId is not a false wrong-spec
  // (matches updateParagraphText / setParagraphVanish).
  if (owned.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };

  // Fast no-op path: if the comment was already accepted, return the stored
  // noteId WITHOUT requiring writability — a retry writes nothing, and the
  // client (e.g. recovering from a timed-out first request) needs the id back
  // even on an archived/locked spec. Provenance alone identifies the note, so
  // this takes no lock and stays off the write path's lock-order entirely.
  const accepted = await findExistingNoteByProvenance(client, nodeId, index);
  if (accepted) return { status: 'already-accepted', noteId: accepted };

  // WRITE PATH. LOCK ORDER (invariant): the spec row is gated/locked BEFORE the
  // paragraph FOR UPDATE — identical to updateParagraphText. Both write paths
  // must take the spec lock first, then the paragraph lock; inverting it here
  // would let a concurrent paragraph PATCH and accept-as-note deadlock holding
  // one lock each.
  await assertSpecWritable(client, specId);

  const anchorRes = await client.query<AnchorRow>(
    `SELECT spec_id, parent_id, position, source_facts FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const anchor = anchorRes.rows[0];
  if (!anchor) return { status: 'not-found' };
  if (anchor.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };

  const text = commentTextAt(anchor.source_facts, index);
  if (text === null) return { status: 'no-comment' };

  const existing = await findExistingNote(client, anchor.parent_id, nodeId, index);
  if (existing) return { status: 'already-accepted', noteId: existing };

  // Persist the canonical spec_id (anchor.spec_id, lowercase from Postgres), not the
  // raw caller-supplied specId which may be uppercase — otherwise the new note row
  // carries a differently-cased spec_id than its siblings (CodeRabbit, data integrity).
  const noteId = await insertNoteSibling(client, anchor, anchor.spec_id, nodeId, index, text);
  return { status: 'created', noteId };
}

export async function acceptCommentAsNote(
  specId: string,
  nodeId: string,
  index: number
): Promise<AcceptNoteOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await runAccept(client, specId, nodeId, index);
    await client.query(outcome.status === 'created' ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('acceptCommentAsNote failed', { cause: err });
  } finally {
    client.release();
  }
}
