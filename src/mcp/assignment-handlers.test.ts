import { describe, it, expect, vi, beforeEach } from 'vitest';

// The 23503 backstop relies on getPgCode(err) unwrapping a DatabaseError's cause,
// so the mocked db module must export a real DatabaseError class (pg-errors.ts
// imports it from the same module and does an `instanceof` check).
vi.mock('../db/index.js', () => ({
  pool: {},
  DatabaseError: class DatabaseError extends Error {
    cause?: unknown;
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DatabaseError';
      this.cause = options?.cause;
    }
  },
  getTemplate: vi.fn(),
  setSpecStyleSource: vi.fn(),
  clearSpecStyleSource: vi.fn(),
  getNumberingProfile: vi.fn(),
  setSpecNumberingProfile: vi.fn(),
  clearSpecNumberingProfile: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000001';
const PROFILE_ID = '20000000-0000-4000-8000-000000000002';
const TEMPLATE_ID = '30000000-0000-4000-8000-000000000003';

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

describe('handleAssignNumberingProfile — delete-race FK backstop (#366)', () => {
  it('(#366) FK 23503 race (profile deleted after EXISTS snapshot) → not-found toolError, not internal error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getNumberingProfile).mockResolvedValueOnce({ name: 'Doomed' } as never);
    // The UPDATE's EXISTS subquery still sees the profile on its statement
    // snapshot, but the RI FK trigger finds it concurrently deleted → 23503,
    // wrapped by setSpecNumberingProfile in a DatabaseError.
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503' });
    vi.mocked(db.setSpecNumberingProfile).mockRejectedValueOnce(
      new db.DatabaseError('setSpecNumberingProfile: update failed', { cause: pgErr })
    );

    const { handleAssignNumberingProfile } = await import('./assignment-handlers.js');
    const result = await handleAssignNumberingProfile({ specId: SPEC_ID, profileId: PROFILE_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('numbering profile not found');
  });

  it('a non-23503 failure still surfaces as a generic internal error (not not-found)', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getNumberingProfile).mockResolvedValueOnce({ name: 'P' } as never);
    vi.mocked(db.setSpecNumberingProfile).mockRejectedValueOnce(new Error('connection reset'));

    const { handleAssignNumberingProfile } = await import('./assignment-handlers.js');
    const result = await handleAssignNumberingProfile({ specId: SPEC_ID, profileId: PROFILE_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('Internal error');
  });
});

describe('handleAssignStyleSource — delete-race FK backstop (#366/#318)', () => {
  it('(#366) FK 23503 race (template deleted after EXISTS snapshot) → not-found toolError', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getTemplate).mockResolvedValueOnce({ name: 'Doomed' } as never);
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503' });
    vi.mocked(db.setSpecStyleSource).mockRejectedValueOnce(
      new db.DatabaseError('failed to set spec style source', { cause: pgErr })
    );

    const { handleAssignStyleSource } = await import('./assignment-handlers.js');
    const result = await handleAssignStyleSource({ specId: SPEC_ID, templateId: TEMPLATE_ID });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain('template not found');
  });
});
