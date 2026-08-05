import type { ColumnSpec } from './batch-insert.js';
import type { ObjectMeta, SignalConflict, SignalProvenance, SourceFacts } from '../../ast/index.js';

// Split out of paragraphs.ts (#618): with this shape inlined, paragraphs.ts
// measured over the repo's enforced 400-line max-lines cap. paragraphs.ts
// already has several such companion files (object-text-edit.ts,
// object-meta.ts, node-type.ts, inference-meta.ts, associations.ts) — this
// follows the same convention.

/** One flattened `paragraphs` row, as produced by paragraphs.ts's DFS walk of
 *  a `SpecTree` (`flattenDfs`) and consumed by {@link paragraphRowToParams}. */
export interface FlatRow {
  readonly id: string;
  readonly specId: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly sourceFacts: SourceFacts;
  readonly signalProvenance: SignalProvenance | null;
  /** Captured DOCX body object (#300, ADR-072). Non-null only on `type: 'object'` rows. */
  readonly objectData: ObjectMeta | null;
  /** Manual page break (#497, ADR-075). True === node begins on a new page. */
  readonly pageBreakBefore: boolean;
  /** Per-node acknowledgement (#545, ADR-079 follow-on). True === acknowledged. */
  readonly acknowledged: boolean;
}

/** Column order for a batched `INSERT INTO paragraphs`, matching
 *  {@link FlatRow}'s field order exactly — {@link paragraphRowToParams} must
 *  emit params in this same order. */
export const PARAGRAPH_COLUMNS: readonly ColumnSpec[] = [
  { name: 'id' },
  { name: 'spec_id' },
  { name: 'parent_id' },
  { name: 'node_type' },
  { name: 'text' },
  { name: 'position' },
  { name: 'vanish' },
  { name: 'conflicts', cast: 'jsonb' },
  { name: 'source_facts', cast: 'jsonb' },
  { name: 'signal_provenance', cast: 'jsonb' },
  { name: 'object_data', cast: 'jsonb' },
  { name: 'page_break_before' },
  { name: 'acknowledged' },
];

/** One row's bind params, in {@link PARAGRAPH_COLUMNS} order. Pure — no I/O. */
export function paragraphRowToParams(row: FlatRow): readonly unknown[] {
  return [
    row.id,
    row.specId,
    row.parentId,
    row.nodeType,
    row.text,
    row.position,
    row.vanish,
    JSON.stringify(row.conflicts),
    JSON.stringify(row.sourceFacts),
    row.signalProvenance ? JSON.stringify(row.signalProvenance) : null,
    row.objectData ? JSON.stringify(row.objectData) : null,
    row.pageBreakBefore,
    row.acknowledged,
  ];
}
