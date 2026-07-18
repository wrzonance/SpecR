import { createHash } from 'node:crypto';
import type { ObjectKind } from '../ast/index.js';

/**
 * One fast-xml-parser `preserveOrder: true` node, structurally: a single-key
 * element wrapper whose value is either further child nodes or raw text,
 * plus an optional `:@` attribute record. Deliberately looser than
 * `ObjectBlobNode` (ast) or the internal `OrderedNode` (extract.ts) — this
 * module reads only tag shape, never attribute values or text — so both are
 * assignable here with zero cast.
 */
export interface FingerprintNode {
  readonly [key: string]: unknown;
}

/**
 * A structural summary of one body-level object's OOXML blob (#520):
 * text-blind, structure-sensitive. `rows`/`columns` are table-only (grid
 * dimensions) and declared as optional KEYS — mirroring `ObjectMeta`'s own
 * `exactOptional()` shape — so this survives `exactOptionalPropertyTypes`
 * without an adapter at the Zod boundary (src/ast/merge-schemas.ts).
 */
export interface ObjectStructureFingerprint {
  readonly kind: ObjectKind;
  readonly rows?: number;
  readonly columns?: number;
  readonly hash: string;
}

const TABLE_TAG = 'w:tbl';
const ROW_TAG = 'w:tr';
const CELL_TAG = 'w:tc';
const GRID_COLUMN_TAG = 'w:gridCol';
const TEXT_TAG = '#text';

function tagOf(node: FingerprintNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

function childrenOf(node: FingerprintNode, tag: string): readonly FingerprintNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as FingerprintNode[]) : [];
}

/** Depth-first collection of every descendant (including top-level) tagged `tag`. */
function findAllByTag(nodes: readonly FingerprintNode[], tag: string): readonly FingerprintNode[] {
  return nodes.flatMap((node) => {
    const nodeTag = tagOf(node);
    if (nodeTag === undefined) return [];
    const nested = findAllByTag(childrenOf(node, nodeTag), tag);
    return nodeTag === tag ? [node, ...nested] : nested;
  });
}

/**
 * Canonical, text-blind shape of one node: its tag plus its children's
 * shapes, in document order. Attribute values and `#text` content never
 * enter the shape — only tag names and nesting count — so editing cell or
 * paragraph text leaves the fingerprint unchanged while adding or removing
 * structure (a row, a column, a nested element) changes it.
 */
function structuralShape(node: FingerprintNode): string {
  const tag = tagOf(node);
  if (tag === undefined || tag === TEXT_TAG) return '';
  const childShapes = childrenOf(node, tag).map(structuralShape).join(',');
  return `${tag}(${childShapes})`;
}

function inferKind(nodes: readonly FingerprintNode[]): ObjectKind {
  return nodes.some((node) => tagOf(node) === TABLE_TAG) ? 'table' : 'textBox';
}

/** Grid column count from `w:tblGrid`, falling back to the widest row's cell count. */
function countColumns(nodes: readonly FingerprintNode[]): number {
  const gridColumns = findAllByTag(nodes, GRID_COLUMN_TAG).length;
  if (gridColumns > 0) return gridColumns;
  const rows = findAllByTag(nodes, ROW_TAG);
  return rows.reduce((widest, row) => Math.max(widest, findAllByTag([row], CELL_TAG).length), 0);
}

/**
 * Structural fingerprint of a body-level object's blob (#520): text-blind,
 * structure-sensitive. `kind`/`rows`/`columns` are inferred straight from
 * the blob's own tag shape — no `ObjectMeta` lookup needed, so callers can
 * fingerprint either a freshly-parsed blob or one already round-tripped
 * through storage.
 */
export function fingerprintBlob(nodes: readonly FingerprintNode[]): ObjectStructureFingerprint {
  const kind = inferKind(nodes);
  const hash = createHash('sha256').update(nodes.map(structuralShape).join('|')).digest('hex');
  if (kind !== 'table') return { kind, hash };
  return { kind, rows: findAllByTag(nodes, ROW_TAG).length, columns: countColumns(nodes), hash };
}

/** True when two fingerprints describe structurally different objects. */
export function fingerprintsDiverge(
  base: ObjectStructureFingerprint,
  theirs: ObjectStructureFingerprint
): boolean {
  return base.hash !== theirs.hash;
}
