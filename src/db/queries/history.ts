import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import type { ParagraphHistoryOp } from './paragraph-history.js';
import { getCheckpointBoundariesForSpec } from './checkpoints.js';
import { coalesceParagraphSessions } from './session-coalesce.js';
import type { ParagraphHistorySession } from './session-coalesce.js';

export interface Queryable {
  query: Pool['query'];
}

export interface ParagraphHistoryEntry {
  readonly specId: string;
  readonly custody: 'origin' | 'spec';
  readonly version: number;
  readonly text: string;
  readonly nodeType: string;
  readonly op: ParagraphHistoryOp;
  readonly contentVersion: number | null;
  readonly snapshotAt: string;
  /** Actor who produced this row; null for a synthetic tip/derive-point
   *  entry (no actor column on paragraphs/specs) or a pre-046 row. */
  readonly userId: string | null;
  /** `users.label` for {@link userId} — null exactly when userId is null. */
  readonly actorLabel: string | null;
}

export interface HistoryOperationCounts {
  readonly edited: number;
  readonly inserted: number;
  readonly removed: number;
}

export interface SpecHistoryStep {
  readonly contentVersion: number;
  readonly at: string;
  readonly ops: HistoryOperationCounts;
}

export type SpecHistoryMilestone =
  | {
      readonly kind: 'origin';
      readonly at: string;
      readonly parentSpecId: string | null;
      readonly originVersion: number;
    }
  | {
      readonly kind: 'revision';
      readonly at: string;
      readonly revisionId: string;
      readonly packageId: string;
      readonly label: string;
    }
  | {
      readonly kind: 'checkpoint';
      readonly at: string;
      readonly checkpointId: string;
      readonly name: string;
      readonly contentVersion: number;
    };

export interface SpecHistory {
  readonly specId: string;
  readonly currentContentVersion: number;
  readonly steps: readonly SpecHistoryStep[];
  readonly milestones: readonly SpecHistoryMilestone[];
}

interface ParagraphContextRow {
  readonly id: string;
  readonly spec_id: string;
  readonly origin_paragraph_id: string | null;
  readonly base_version: number;
  readonly text: string;
  readonly node_type: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly content_version: number;
  readonly parent_spec_id: string | null;
  readonly origin_version: number | null;
  readonly spec_created_at: Date;
}

interface HistoryRow {
  readonly spec_id: string;
  readonly version: number;
  readonly text: string;
  readonly node_type: string;
  readonly op: ParagraphHistoryOp;
  readonly content_version: number | null;
  readonly snapshot_at: Date;
  readonly payload: unknown;
  readonly user_id: string | null;
  readonly actor_label: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function paragraphContext(
  specId: string,
  paragraphId: string,
  db: Queryable
): Promise<ParagraphContextRow | null> {
  const result = await db.query<ParagraphContextRow>(
    `SELECT p.id, p.spec_id, p.origin_paragraph_id, p.base_version, p.text, p.node_type,
            p.created_at, p.updated_at, s.content_version, s.parent_spec_id,
            s.origin_version, s.created_at AS spec_created_at
     FROM paragraphs p JOIN specs s ON s.id = p.spec_id
     WHERE p.id = $2 AND p.spec_id = $1`,
    [specId, paragraphId]
  );
  return result.rows[0] ?? null;
}

async function historyRows(paragraphId: string, db: Queryable): Promise<readonly HistoryRow[]> {
  const result = await db.query<HistoryRow>(
    `SELECT pv.spec_id, pv.version, pv.text, pv.node_type, pv.op, pv.content_version,
            pv.snapshot_at, pv.payload, pv.user_id, u.label AS actor_label
     FROM paragraph_versions pv
     LEFT JOIN users u ON u.id = pv.user_id
     WHERE pv.paragraph_id = $1
     ORDER BY pv.version, pv.snapshot_at, pv.id`,
    [paragraphId]
  );
  return result.rows;
}

function mapEntry(row: HistoryRow, custody: 'origin' | 'spec'): ParagraphHistoryEntry {
  return {
    specId: row.spec_id,
    custody,
    version: row.version,
    text: row.text,
    nodeType: row.node_type,
    op: row.op,
    contentVersion: row.content_version,
    snapshotAt: iso(row.snapshot_at),
    userId: row.user_id,
    actorLabel: row.actor_label,
  };
}

function ensureCurrentTip(
  rows: readonly HistoryRow[],
  context: ParagraphContextRow,
  custody: 'origin' | 'spec'
): readonly ParagraphHistoryEntry[] {
  const mapped = rows.map((row) => mapEntry(row, custody));
  const last = rows.at(-1);
  if (
    last?.version === context.base_version &&
    last.text === context.text &&
    last.node_type === context.node_type
  ) {
    return mapped;
  }
  return [
    ...mapped,
    {
      specId: context.spec_id,
      custody,
      version: context.base_version,
      text: context.text,
      nodeType: context.node_type,
      op: last ? 'edit' : 'insert',
      contentVersion: last ? context.content_version : 1,
      snapshotAt: iso(last ? context.updated_at : context.created_at),
      userId: null, // synthetic — no actor column on paragraphs/specs
      actorLabel: null,
    },
  ];
}

function prependDerivePoint(
  rows: readonly HistoryRow[],
  entries: readonly ParagraphHistoryEntry[],
  context: ParagraphContextRow,
  origin: readonly ParagraphHistoryEntry[]
): readonly ParagraphHistoryEntry[] {
  if (rows.some((row) => row.op === 'insert') || rows.length === 0) return entries;
  const baseline = origin.at(-1);
  const firstVersion = rows[0]?.version;
  if (!baseline || firstVersion === undefined) return entries;
  return [
    {
      specId: context.spec_id,
      custody: 'spec',
      version: Math.max(1, firstVersion - 1),
      text: baseline.text,
      nodeType: baseline.nodeType,
      op: 'insert',
      contentVersion: 1,
      snapshotAt: iso(context.spec_created_at),
      userId: null, // synthetic — see ensureCurrentTip
      actorLabel: null,
    },
    ...entries,
  ];
}

async function originEntries(
  local: ParagraphContextRow,
  db: Queryable
): Promise<readonly ParagraphHistoryEntry[]> {
  if (!local.parent_spec_id || !local.origin_paragraph_id || local.origin_version === null)
    return [];
  const originVersion = local.origin_version;
  const origin = await paragraphContext(local.parent_spec_id, local.origin_paragraph_id, db);
  if (!origin) return [];
  const rows = (await historyRows(origin.id, db)).filter(
    (row) =>
      (row.content_version !== null && row.content_version <= originVersion) ||
      (row.content_version === null && row.snapshot_at <= local.spec_created_at)
  );
  return ensureCurrentTip(rows, origin, 'origin').filter(
    (entry) => entry.contentVersion === null || entry.contentVersion <= originVersion
  );
}

/** Raw paragraph iterations, oldest first. By default the project copy starts
 * at its derive point; includeOrigin prepends the direct master's pre-derive
 * iterations through origin_paragraph_id (ADR-052 D5). */
export async function getParagraphHistory(
  specId: string,
  paragraphId: string,
  includeOrigin = false,
  db: Queryable = pool
): Promise<readonly ParagraphHistoryEntry[] | null> {
  try {
    const context = await paragraphContext(specId, paragraphId, db);
    if (!context) return null;
    const rows = await historyRows(paragraphId, db);
    const origin = await originEntries(context, db);
    const local = prependDerivePoint(
      rows,
      ensureCurrentTip(rows, context, 'spec'),
      context,
      origin
    );
    return includeOrigin ? [...origin, ...local] : local;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getParagraphHistory failed for paragraph ${paragraphId}`, {
      cause: err,
    });
  }
}

/** Tier-1 read (ADR-052 D3): {@link getParagraphHistory}'s entries folded into
 *  coalesced sessions. When includeOrigin, also fetches the origin spec's OWN
 *  boundaries — origin/local specs keep independent content_version counters
 *  (ADR-052 D5), so sealing origin entries against only the local spec's
 *  boundaries would use an unrelated axis (#380 review finding); each
 *  CheckpointBoundary now carries its own specId so the coalescer can tell
 *  them apart once merged. Same not-found `null` as getParagraphHistory. */
export async function getCoalescedParagraphHistory(
  specId: string,
  paragraphId: string,
  sessionWindowMs: number,
  includeOrigin = false,
  db: Queryable = pool
): Promise<readonly ParagraphHistorySession[] | null> {
  try {
    const entries = await getParagraphHistory(specId, paragraphId, includeOrigin, db);
    if (!entries) return null;
    const originSpecId = entries.find((entry) => entry.custody === 'origin')?.specId;
    const originBoundaries = originSpecId
      ? await getCheckpointBoundariesForSpec(originSpecId, db)
      : [];
    const boundaries = [...originBoundaries, ...(await getCheckpointBoundariesForSpec(specId, db))];
    return coalesceParagraphSessions(entries, boundaries, sessionWindowMs);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getCoalescedParagraphHistory failed for paragraph ${paragraphId}`, {
      cause: err,
    });
  }
}

function emptyCounts(): HistoryOperationCounts {
  return { edited: 0, inserted: 0, removed: 0 };
}

function mergeDiffKind(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('diffKind' in payload)) return null;
  const value = payload.diffKind;
  return typeof value === 'string' ? value : null;
}

/** getSpecHistory's own step-aggregation columns — narrower than
 *  {@link HistoryRow}, which now also carries actor-join columns this
 *  content_version-scoped query never selects. */
interface ContentVersionStepRow {
  readonly content_version: number | null;
  readonly snapshot_at: Date;
  readonly op: ParagraphHistoryOp;
  readonly payload: unknown;
}

function increment(
  counts: HistoryOperationCounts,
  row: ContentVersionStepRow
): HistoryOperationCounts {
  const diffKind = row.op === 'merge' ? mergeDiffKind(row.payload) : null;
  if (
    row.op === 'insert' ||
    row.op === 'accept-note' ||
    row.op === 'restore' ||
    diffKind === 'added'
  ) {
    return { ...counts, inserted: counts.inserted + 1 };
  }
  if (row.op === 'remove' || diffKind === 'deleted') {
    return { ...counts, removed: counts.removed + 1 };
  }
  return { ...counts, edited: counts.edited + 1 };
}

interface SpecContextRow {
  readonly content_version: number;
  readonly created_at: Date;
  readonly parent_spec_id: string | null;
  readonly origin_version: number | null;
}

interface RevisionMilestoneRow {
  readonly revision_id: string;
  readonly package_id: string;
  readonly label: string;
  readonly issued_at: Date;
}

async function revisionMilestones(
  specId: string,
  packageId: string | undefined,
  db: Queryable
): Promise<readonly SpecHistoryMilestone[]> {
  const result = await db.query<RevisionMilestoneRow>(
    `SELECT pr.id AS revision_id, pr.package_id, pr.label, pr.issued_at
     FROM package_revision_specs prs
     JOIN package_revisions pr ON pr.id = prs.revision_id
     WHERE prs.spec_id = $1 AND ($2::uuid IS NULL OR pr.package_id = $2)
     ORDER BY pr.issued_at, pr.id`,
    [specId, packageId ?? null]
  );
  return result.rows.map((row) => ({
    kind: 'revision',
    at: iso(row.issued_at),
    revisionId: row.revision_id,
    packageId: row.package_id,
    label: row.label,
  }));
}

interface CheckpointMilestoneRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly content_version: number;
}

/** Checkpoints applying to `specId` (own + covering project-scoped),
 *  ascending — own query rather than getCheckpointBoundariesForSpec because
 *  the timeline also needs the checkpoint's `name`. $1::uuid::text (not a bare
 *  $1::text, #380 review finding) canonicalizes specId's letter-casing before
 *  it's compared against the jsonb keys — mirrors checkpoints.ts's own
 *  boundary queries, so this duplicated read path can't regress separately. */
async function checkpointMilestones(
  specId: string,
  db: Queryable
): Promise<readonly SpecHistoryMilestone[]> {
  const result = await db.query<CheckpointMilestoneRow>(
    `SELECT id, name, created_at, (content_version_map ->> $1::uuid::text)::int AS content_version
     FROM checkpoints
     WHERE content_version_map ? $1::uuid::text
     ORDER BY content_version ASC, created_at ASC, id ASC`,
    [specId]
  );
  return result.rows.map((row) => ({
    kind: 'checkpoint',
    at: iso(row.created_at),
    checkpointId: row.id,
    name: row.name,
    contentVersion: row.content_version,
  }));
}

async function specHistorySteps(
  specId: string,
  context: SpecContextRow,
  db: Queryable
): Promise<readonly SpecHistoryStep[]> {
  const history = await db.query<ContentVersionStepRow>(
    `SELECT op, content_version, snapshot_at, payload
     FROM paragraph_versions
     WHERE spec_id = $1 AND content_version IS NOT NULL AND content_version <= $2
     ORDER BY content_version, snapshot_at, id`,
    [specId, context.content_version]
  );
  const groups = new Map<number, { at: string; ops: HistoryOperationCounts }>();
  for (const row of history.rows) {
    if (row.content_version === null) continue;
    const current = groups.get(row.content_version) ?? {
      at: iso(row.snapshot_at),
      ops: emptyCounts(),
    };
    groups.set(row.content_version, { at: current.at, ops: increment(current.ops, row) });
  }
  if (!groups.has(1)) groups.set(1, { at: iso(context.created_at), ops: emptyCounts() });
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([contentVersion, value]) => ({ contentVersion, ...value }));
}

/** Spec content-version steps with paragraph-op summaries and immutable
 * issuance milestones. packageId narrows only revision milestones; the spec's
 * own edit timeline remains branch-wide. */
export async function getSpecHistory(
  specId: string,
  packageId?: string,
  db: Queryable = pool
): Promise<SpecHistory | null> {
  try {
    const spec = await db.query<SpecContextRow>(
      `SELECT content_version, created_at, parent_spec_id, origin_version FROM specs WHERE id = $1`,
      [specId]
    );
    const context = spec.rows[0];
    if (!context) return null;
    const steps = await specHistorySteps(specId, context, db);
    const origin: SpecHistoryMilestone = {
      kind: 'origin',
      at: iso(context.created_at),
      parentSpecId: context.parent_spec_id,
      originVersion: context.origin_version ?? 1,
    };
    return {
      specId,
      currentContentVersion: context.content_version,
      steps,
      milestones: [
        origin,
        ...(await revisionMilestones(specId, packageId, db)),
        ...(await checkpointMilestones(specId, db)),
      ],
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getSpecHistory failed for spec ${specId}`, { cause: err });
  }
}
