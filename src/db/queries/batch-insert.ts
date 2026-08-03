import type { Pool } from 'pg';
import { DatabaseError } from '../index.js';

/** PostgreSQL's hard limit on bind parameters in a single extended-protocol
 *  query (`$1`..`$65535`). A multi-row INSERT with N columns per row can
 *  therefore carry at most `floor(65535 / N)` rows per statement. */
export const POSTGRES_MAX_BIND_PARAMS = 65535;

export interface Queryable {
  query: Pool['query'];
}

/** One column of a chunked multi-row INSERT: its bare name plus an optional
 *  Postgres cast (e.g. `'jsonb'`) applied to every placeholder for that
 *  column. */
export interface ColumnSpec {
  readonly name: string;
  readonly cast?: string;
}

/** What {@link insertRowsInChunks} hands a caller's `buildErrorMessage` when
 *  one chunk's INSERT fails: which chunk (0-based, out of how many), how
 *  many rows it carried, and the source-row ids so the message can name what
 *  failed without re-deriving it from `rows`. */
export interface ChunkFailureContext {
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly rowCount: number;
  readonly ids: readonly string[];
}

/** How many rows of `columnsPerRow` columns each fit in one statement before
 *  crossing `paramLimit` (default {@link POSTGRES_MAX_BIND_PARAMS}) bind
 *  parameters. Throws `RangeError` for a non-positive `columnsPerRow` —
 *  zero columns can never form a valid row and would otherwise divide by
 *  zero. */
export function maxRowsPerStatement(
  columnsPerRow: number,
  paramLimit: number = POSTGRES_MAX_BIND_PARAMS
): number {
  if (columnsPerRow < 1) {
    throw new RangeError(`columnsPerRow must be >= 1, got ${columnsPerRow}`);
  }
  return Math.floor(paramLimit / columnsPerRow);
}

/** Splits `rows` into consecutive chunks of at most `chunkSize` elements,
 *  preserving order — `chunkRows(rows, n).flat()` always deep-equals `rows`.
 *  Throws `RangeError` for a non-positive `chunkSize`. */
export function chunkRows<T>(rows: readonly T[], chunkSize: number): ReadonlyArray<readonly T[]> {
  if (chunkSize < 1) {
    throw new RangeError(`chunkSize must be >= 1, got ${chunkSize}`);
  }
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += chunkSize) {
    chunks.push(rows.slice(start, start + chunkSize));
  }
  return chunks;
}

/** `"col_a, col_b, col_c"` — the column list for the INSERT's target clause. */
export function buildColumnListSql(columns: readonly ColumnSpec[]): string {
  return columns.map((col) => col.name).join(', ');
}

/** `"($1, $2::jsonb), ($3, $4::jsonb)"` — one `(...)` group per row, each
 *  placeholder numbered by absolute position (row-major) and cast per its
 *  {@link ColumnSpec}. */
export function buildValuesSql(columns: readonly ColumnSpec[], rowCount: number): string {
  const rowGroups: string[] = [];
  for (let row = 0; row < rowCount; row++) {
    const placeholders = columns.map((col, colIndex) => {
      const paramNumber = row * columns.length + colIndex + 1;
      const suffix = col.cast ? `::${col.cast}` : '';
      return `$${paramNumber}${suffix}`;
    });
    rowGroups.push(`(${placeholders.join(', ')})`);
  }
  return rowGroups.join(', ');
}

/** `"a, b, c, +2 more"` — a bounded preview of failing row ids for error
 *  messages, so a batch of thousands never dumps every id inline. */
export function formatIdsPreview(ids: readonly string[], max = 5): string {
  const shown = ids.slice(0, max).join(', ');
  const remaining = ids.length - max;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

/** Inserts `rows` into `table` in chunks sized to stay under Postgres's bind
 *  parameter limit, one multi-row INSERT per chunk. Fail-fast: the first
 *  chunk whose INSERT rejects aborts the loop immediately (remaining chunks
 *  never run) and the underlying error is wrapped as a `DatabaseError` whose
 *  message is `buildErrorMessage(ctx)` — `ctx.ids` names exactly the rows in
 *  the failing chunk via `idOf`, so a caller-formatted message (typically via
 *  {@link formatIdsPreview}) can point at what failed without a second query.
 *  A no-op for `rows.length === 0`. */
export async function insertRowsInChunks<T>(args: {
  readonly db: Queryable;
  readonly table: string;
  readonly columns: readonly ColumnSpec[];
  readonly rows: readonly T[];
  readonly toParams: (row: T) => readonly unknown[];
  readonly idOf: (row: T) => string;
  readonly buildErrorMessage: (ctx: ChunkFailureContext) => string;
  readonly paramLimit?: number;
}): Promise<void> {
  const { db, table, columns, rows, toParams, idOf, buildErrorMessage, paramLimit } = args;
  if (rows.length === 0) return;

  const chunkSize = maxRowsPerStatement(columns.length, paramLimit);
  const chunks = chunkRows(rows, chunkSize);
  const columnListSql = buildColumnListSql(columns);

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const valuesSql = buildValuesSql(columns, chunk.length);
    const params = chunk.flatMap(toParams);
    try {
      await db.query(`INSERT INTO ${table} (${columnListSql}) VALUES ${valuesSql}`, params);
    } catch (err) {
      const context: ChunkFailureContext = {
        chunkIndex,
        totalChunks: chunks.length,
        rowCount: chunk.length,
        ids: chunk.map(idOf),
      };
      throw new DatabaseError(buildErrorMessage(context), { cause: err });
    }
  }
}
