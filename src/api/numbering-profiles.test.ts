import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// getPgCode(err) unwraps a DatabaseError's cause, so the mocked db must export a
// real DatabaseError class (pg-errors.ts imports it from the same mocked module).
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
  NumberingProfileInUseError: class NumberingProfileInUseError extends Error {},
  listNumberingProfiles: vi.fn(),
  getNumberingProfile: vi.fn(),
  createNumberingProfile: vi.fn(),
  updateNumberingProfile: vi.fn(),
  deleteNumberingProfile: vi.fn(),
  setSpecNumberingProfile: vi.fn(),
  clearSpecNumberingProfile: vi.fn(),
  findLibraryById: vi.fn(),
}));

vi.mock('../parser/index.js', () => ({
  assertDocxSafe: vi.fn(),
  extractNumberingProfileFromDocx: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

const SPEC_ID = '10000000-0000-4000-8000-000000000001';
const PROFILE_ID = '20000000-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('setSpecProfileHandler — delete-race FK backstop (#366)', () => {
  it('(#366) FK 23503 race (profile deleted after EXISTS snapshot) → 404, not 500', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getNumberingProfile).mockResolvedValueOnce({ name: 'Doomed' } as never);
    // The UPDATE's EXISTS subquery still sees the profile on its statement snapshot,
    // but the RI FK trigger finds it concurrently deleted → 23503, wrapped by
    // setSpecNumberingProfile in a DatabaseError.
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503' });
    vi.mocked(db.setSpecNumberingProfile).mockRejectedValueOnce(
      new db.DatabaseError('setSpecNumberingProfile: update failed', { cause: pgErr })
    );

    const { setSpecProfileHandler } = await import('./numbering-profiles.js');
    const req = { params: { id: SPEC_ID }, body: { profileId: PROFILE_ID } } as unknown as Request;
    const res = makeRes();
    await setSpecProfileHandler(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('numbering profile not found');
  });

  it('a non-23503 failure still surfaces as 500', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getNumberingProfile).mockResolvedValueOnce({ name: 'P' } as never);
    vi.mocked(db.setSpecNumberingProfile).mockRejectedValueOnce(new Error('connection reset'));

    const { setSpecProfileHandler } = await import('./numbering-profiles.js');
    const req = { params: { id: SPEC_ID }, body: { profileId: PROFILE_ID } } as unknown as Request;
    const res = makeRes();
    await setSpecProfileHandler(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
