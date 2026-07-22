import { PageSizeSchema } from '../../ast/index.js';
import type { PageSize, SpecTree } from '../../ast/index.js';

// Read/write helpers for the specs.page_size JSONB column (#509, ADR-075),
// kept out of specs.ts so that file stays within its 400-line budget.

/**
 * The specs.page_size JSONB column is untrusted DB boundary input: validate it
 * against PageSizeSchema and map a malformed/absent value to undefined so a
 * reconstructed tree never carries a partial page size — resolvePageSize then
 * applies the Letter default, exactly as for a source that never captured one.
 */
export function parseStoredPageSize(raw: unknown): PageSize | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = PageSizeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** JSONB parameter for an INSERT/UPDATE: the serialized page size, or null when
 *  the tree captured none (a `.SEC` source or a DOCX lacking `w:pgSz`). */
export function serializePageSize(tree: SpecTree): string | null {
  return tree.pageSize ? JSON.stringify(tree.pageSize) : null;
}
