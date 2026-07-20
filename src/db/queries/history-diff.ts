import { SpecTreeSchema } from '../../ast/index.js';
import type { SpecNode, SpecTree } from '../../ast/index.js';
import { pool, DatabaseError } from '../index.js';
import type { ParagraphHistoryOp } from './paragraph-history.js';
import type { Queryable } from './history.js';

export type HistoryAnchor = number | string;

export class HistoryAnchorError extends DatabaseError {}

export interface HistoryDiffEntry {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly beforeText: string | null;
  readonly afterText: string | null;
}

export interface SpecHistoryDiff {
  readonly specId: string;
  readonly from: HistoryAnchor;
  readonly to: HistoryAnchor;
  readonly added: readonly HistoryDiffEntry[];
  readonly removed: readonly HistoryDiffEntry[];
  readonly modified: readonly HistoryDiffEntry[];
}

interface ParagraphRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly node_type: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
}

interface VersionRow {
  readonly paragraph_id: string;
  readonly text: string;
  readonly node_type: string;
  readonly op: ParagraphHistoryOp;
  readonly content_version: number | null;
  readonly payload: unknown;
}

interface SnapshotNode {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly text: string;
}

interface SpecAnchorContext {
  readonly content_version: number;
  readonly parent_spec_id: string | null;
  readonly origin_version: number | null;
}

async function liveRows(specId: string, db: Queryable): Promise<readonly ParagraphRow[]> {
  const result = await db.query<ParagraphRow>(
    `SELECT id, parent_id, node_type, text, position, vanish
     FROM paragraphs WHERE spec_id = $1 ORDER BY position, id`,
    [specId]
  );
  return result.rows;
}

async function versionRows(specId: string, db: Queryable): Promise<readonly VersionRow[]> {
  const result = await db.query<VersionRow>(
    `SELECT paragraph_id, text, node_type, op, content_version, payload
     FROM paragraph_versions
     WHERE spec_id = $1 AND content_version IS NOT NULL
     ORDER BY content_version, snapshot_at, id`,
    [specId]
  );
  return result.rows;
}

function childrenByParent(
  rows: readonly ParagraphRow[]
): ReadonlyMap<string | null, ParagraphRow[]> {
  const children = new Map<string | null, ParagraphRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.parent_id) ?? [];
    children.set(row.parent_id, [...siblings, row]);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id)
    );
  }
  return children;
}

function mergeVisibility(row: VersionRow, visible: boolean): boolean {
  if (row.op === 'remove') return false;
  if (row.op === 'restore' || row.op === 'insert') return true;
  if (row.op !== 'merge' || typeof row.payload !== 'object' || row.payload === null) return visible;
  if (!('diffKind' in row.payload)) return visible;
  if (row.payload.diffKind === 'deleted') return false;
  if (row.payload.diffKind === 'added') return true;
  return visible;
}

function createsParagraph(row: VersionRow): boolean {
  if (row.op === 'insert' || row.op === 'accept-note') return true;
  if (row.op !== 'merge' || typeof row.payload !== 'object' || row.payload === null) return false;
  return 'diffKind' in row.payload && row.payload.diffKind === 'added';
}

interface HistoricalNodeState {
  readonly ownVisible: boolean;
  readonly latest: VersionRow | undefined;
}

function historicalNodeState(
  row: ParagraphRow,
  versions: readonly VersionRow[],
  contentVersion: number | 'current'
): HistoricalNodeState {
  const candidates = versions.filter(
    (version) => contentVersion === 'current' || (version.content_version ?? 0) <= contentVersion
  );
  const creation = versions.find(createsParagraph);
  let ownVisible =
    contentVersion === 'current' ||
    creation === undefined ||
    (creation.content_version ?? Number.MAX_SAFE_INTEGER) <= contentVersion;
  for (const candidate of candidates) ownVisible = mergeVisibility(candidate, ownVisible);
  if (contentVersion === 'current') {
    ownVisible = ownVisible && (!row.vanish || row.node_type === 'note');
  }
  return { ownVisible, latest: candidates.at(-1) };
}

function snapshotNode(
  row: ParagraphRow,
  latest: VersionRow | undefined,
  prior: SnapshotNode | undefined,
  current: boolean
): SnapshotNode {
  if (current) return { nodeId: row.id, nodeType: row.node_type, text: row.text };
  if (latest) return { nodeId: row.id, nodeType: latest.node_type, text: latest.text };
  if (prior) return prior;
  return { nodeId: row.id, nodeType: row.node_type, text: row.text };
}

function snapshotFromRows(
  rows: readonly ParagraphRow[],
  versions: readonly VersionRow[],
  contentVersion: number | 'current',
  baseline: readonly SnapshotNode[] = []
): readonly SnapshotNode[] {
  const baselineById = new Map(baseline.map((node) => [node.nodeId, node]));
  const byParagraph = new Map<string, VersionRow[]>();
  for (const row of versions) {
    byParagraph.set(row.paragraph_id, [...(byParagraph.get(row.paragraph_id) ?? []), row]);
  }
  const children = childrenByParent(rows);
  const out: SnapshotNode[] = [];
  const walk = (parentId: string | null, parentVisible: boolean): void => {
    for (const row of children.get(parentId) ?? []) {
      const state = historicalNodeState(row, byParagraph.get(row.id) ?? [], contentVersion);
      const visible = parentVisible && state.ownVisible;
      const prior = baselineById.get(row.id);
      if (visible) {
        out.push(snapshotNode(row, state.latest, prior, contentVersion === 'current'));
      }
      walk(row.id, visible);
    }
  };
  walk(null, true);
  return out;
}

async function contentSnapshot(
  specId: string,
  contentVersion: number | 'current',
  db: Queryable,
  baseline: readonly SnapshotNode[] = []
): Promise<readonly SnapshotNode[]> {
  return snapshotFromRows(
    await liveRows(specId, db),
    await versionRows(specId, db),
    contentVersion,
    baseline
  );
}

function flattenTree(tree: SpecTree): readonly SnapshotNode[] {
  const out: SnapshotNode[] = [];
  const walk = (nodes: readonly SpecNode[], parentVisible: boolean): void => {
    for (const node of nodes) {
      const visible = parentVisible && (!node.meta.vanish || node.type === 'note');
      if (visible) {
        out.push({ nodeId: node.id, nodeType: node.type, text: node.text });
      }
      walk(node.children, visible);
    }
  };
  walk(tree.parts, true);
  return out;
}

async function revisionSnapshot(
  specId: string,
  revisionId: string,
  db: Queryable
): Promise<readonly SnapshotNode[]> {
  const result = await db.query<{ tree: unknown }>(
    `SELECT tree FROM package_revision_specs WHERE revision_id = $1 AND spec_id = $2`,
    [revisionId, specId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new HistoryAnchorError(`revision ${revisionId} did not snapshot spec ${specId}`);
  }
  return flattenTree(SpecTreeSchema.parse(row.tree));
}

async function originSnapshot(
  specId: string,
  context: SpecAnchorContext,
  db: Queryable
): Promise<readonly SnapshotNode[]> {
  if (!context.parent_spec_id || context.origin_version === null) {
    return contentSnapshot(specId, 1, db);
  }
  const parent = await contentSnapshot(context.parent_spec_id, context.origin_version, db);
  const mappings = await db.query<{ id: string; origin_paragraph_id: string }>(
    `SELECT id, origin_paragraph_id FROM paragraphs
     WHERE spec_id = $1 AND origin_paragraph_id IS NOT NULL`,
    [specId]
  );
  const cloneByOrigin = new Map(mappings.rows.map((row) => [row.origin_paragraph_id, row.id]));
  return parent.flatMap((node) => {
    const cloneId = cloneByOrigin.get(node.nodeId);
    return cloneId ? [{ ...node, nodeId: cloneId }] : [];
  });
}

async function resolveSnapshot(
  specId: string,
  anchor: HistoryAnchor,
  context: SpecAnchorContext,
  db: Queryable
): Promise<readonly SnapshotNode[]> {
  if (anchor === 'current') return contentSnapshot(specId, 'current', db);
  if (anchor === 'origin') return originSnapshot(specId, context, db);
  if (typeof anchor === 'number') {
    if (anchor < 1 || anchor > context.content_version) {
      throw new HistoryAnchorError(
        `content version ${anchor} is outside spec ${specId}'s history (1-${context.content_version})`
      );
    }
    const baseline =
      context.parent_spec_id && context.origin_version !== null
        ? await originSnapshot(specId, context, db)
        : [];
    return contentSnapshot(specId, anchor, db, baseline);
  }
  return revisionSnapshot(specId, anchor, db);
}

function entry(
  nodeId: string,
  nodeType: string,
  beforeText: string | null,
  afterText: string | null
): HistoryDiffEntry {
  return { nodeId, nodeType, beforeText, afterText };
}

function compareSnapshots(
  before: readonly SnapshotNode[],
  after: readonly SnapshotNode[]
): Pick<SpecHistoryDiff, 'added' | 'removed' | 'modified'> {
  const beforeById = new Map(before.map((node) => [node.nodeId, node]));
  const afterById = new Map(after.map((node) => [node.nodeId, node]));
  const added = after
    .filter((node) => !beforeById.has(node.nodeId))
    .map((node) => entry(node.nodeId, node.nodeType, null, node.text));
  const removed = before
    .filter((node) => !afterById.has(node.nodeId))
    .map((node) => entry(node.nodeId, node.nodeType, node.text, null));
  const modified = after.flatMap((node) => {
    const prior = beforeById.get(node.nodeId);
    if (!prior || (prior.text === node.text && prior.nodeType === node.nodeType)) return [];
    return [entry(node.nodeId, node.nodeType, prior.text, node.text)];
  });
  return { added, removed, modified };
}

/** Compare two stored states of one spec. Anchors are a content_version,
 * immutable package revision UUID, `origin`, or `current`; output follows the
 * merge engine's added/removed/modified vocabulary without word-level diffing. */
export async function getSpecHistoryDiff(
  specId: string,
  from: HistoryAnchor,
  to: HistoryAnchor,
  db: Queryable = pool
): Promise<SpecHistoryDiff | null> {
  try {
    const spec = await db.query<SpecAnchorContext>(
      `SELECT content_version, parent_spec_id, origin_version FROM specs WHERE id = $1`,
      [specId]
    );
    const context = spec.rows[0];
    if (!context) return null;
    const before = await resolveSnapshot(specId, from, context, db);
    const after = await resolveSnapshot(specId, to, context, db);
    return { specId, from, to, ...compareSnapshots(before, after) };
  } catch (err) {
    if (err instanceof HistoryAnchorError || err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getSpecHistoryDiff failed for spec ${specId}`, { cause: err });
  }
}
