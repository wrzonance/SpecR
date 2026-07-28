import { describe, it, expect, vi } from 'vitest';
import { DatabaseError } from '../errors.js';
import { SnapshotValidationError } from './revision-snapshot.js';

// reporting.ts (and its revision-snapshot.ts -> specs.ts dependency chain) import
// `pool` from `../index.js` at module scope; db/index.ts's own module-scope Pool
// construction requires a valid DATABASE_URL (env.ts exits the process without
// one — CLAUDE.md, "fail fast at boot"). This suite never touches the real pool
// (getFrozenComparisonSource always receives an injected fake Queryable below),
// so a minimal stub is enough to let the module graph load under `pnpm test`
// (unit project — no DB). Mirrors src/db/queries/refs.test.ts / object-meta.test.ts.
vi.mock('../index.js', () => ({ pool: {}, DatabaseError: class extends Error {} }));

// The db/queries dependency chain (associations.ts, paragraphs.ts, refs.ts) also
// imports the pino logger directly, which itself reads `config` (env.ts) at
// module scope — same fail-fast-at-boot hazard, mirrors refs.test.ts.
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { getFrozenComparisonSource } from './reporting.js';

/**
 * #392 review finding: getFrozenComparisonSource's stated error-handling
 * contract — unexpected failures wrapped in DatabaseError with `cause`
 * chained; pre-existing DatabaseError subtypes (e.g. SnapshotValidationError,
 * thrown by `validateTree` inside the same try block) re-thrown unwrapped —
 * had zero test coverage. Uses the `db: Queryable` injection point already on
 * the function (no real Postgres needed) to drive both catch-block branches.
 */
function fakeDb(query: ReturnType<typeof vi.fn>): Parameters<typeof getFrozenComparisonSource>[2] {
  return { query } as never;
}

const REVISION_ID = 'rev-1';
const SPEC_ID = 'spec-1';

describe('getFrozenComparisonSource — error-handling contract (#392 review)', () => {
  it('wraps an unexpected query failure in DatabaseError with the original error chained as cause', async () => {
    const pgErr = new Error('connection terminated');
    const db = fakeDb(vi.fn().mockRejectedValue(pgErr));

    const err = await getFrozenComparisonSource(REVISION_ID, SPEC_ID, db).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DatabaseError);
    expect(err).not.toBeInstanceOf(SnapshotValidationError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });

  it('re-throws a pre-existing DatabaseError subtype (SnapshotValidationError) unwrapped, never double-wrapped', async () => {
    const corruptRow = { tree: { not: 'a valid SpecTree' }, revisionLabel: 'rev-label' };
    const db = fakeDb(vi.fn().mockResolvedValue({ rows: [corruptRow] }));

    const err = await getFrozenComparisonSource(REVISION_ID, SPEC_ID, db).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SnapshotValidationError);
    expect((err as Error).message).toContain(
      `snapshot tree for spec ${SPEC_ID} failed SpecTree validation`
    );
    // Unwrapped means the generic wrap message reporting.ts's own catch block
    // would use never appears — a double-wrap would replace this exact message.
    expect((err as Error).message).not.toContain('getFrozenComparisonSource failed');
  });
});
