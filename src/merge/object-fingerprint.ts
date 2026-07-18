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
const GRID_TAG = 'w:tblGrid';
const GRID_COLUMN_TAG = 'w:gridCol';
const TEXT_TAG = '#text';

function tagOf(node: FingerprintNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

function childrenOf(node: FingerprintNode, tag: string): readonly FingerprintNode[] {
  const value = node[tag];
  return Array.isArray(value) ? (value as FingerprintNode[]) : [];
}

/** Direct child nodes tagged `tag` (non-recursive) — never descends into a
 *  nested subtree, so a `w:tbl` inside a cell can't be counted toward its host
 *  table's grid/row totals (nested tables are a KNOWN AMBIGUITY, ADR-072 §20). */
function directByTag(nodes: readonly FingerprintNode[], tag: string): readonly FingerprintNode[] {
  return nodes.filter((node) => tagOf(node) === tag);
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

/**
 * Row and column counts of the OUTERMOST table only (#520 review): every count
 * walks the table's direct structure, never descendants, so a nested `w:tbl`
 * inside a cell can't inflate the host table's `w:tr`/`w:gridCol`/cell totals.
 * Grid column count comes from the table's own `w:tblGrid`, falling back to the
 * widest row's direct cell count.
 */
function tableDimensions(nodes: readonly FingerprintNode[]): {
  readonly rows: number;
  readonly columns: number;
} {
  const table = nodes.find((node) => tagOf(node) === TABLE_TAG);
  const children = table ? childrenOf(table, TABLE_TAG) : [];
  const rowNodes = directByTag(children, ROW_TAG);
  const grid = children.find((child) => tagOf(child) === GRID_TAG);
  const gridColumns = grid ? directByTag(childrenOf(grid, GRID_TAG), GRID_COLUMN_TAG).length : 0;
  const columns =
    gridColumns > 0
      ? gridColumns
      : rowNodes.reduce(
          (widest, row) => Math.max(widest, directByTag(childrenOf(row, ROW_TAG), CELL_TAG).length),
          0
        );
  return { rows: rowNodes.length, columns };
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
  const { rows, columns } = tableDimensions(nodes);
  return { kind, rows, columns, hash };
}

/** True when two fingerprints describe structurally different objects. */
export function fingerprintsDiverge(
  base: ObjectStructureFingerprint,
  theirs: ObjectStructureFingerprint
): boolean {
  return base.hash !== theirs.hash;
}
