import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeSpecNotFound extends Error {}
class FakeProjectNotFound extends Error {}

vi.mock('../db/index.js', () => ({
  getOpenCommentsReport: vi.fn(),
  SpecNotFoundError: FakeSpecNotFound,
  ProjectNotFoundError: FakeProjectNotFound,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC = '10000000-0000-4000-8000-000000000001';
const PROJECT = '20000000-0000-4000-8000-000000000002';

describe('handleOpenCommentsReport — scope resolution (#262)', () => {
  it('errors and skips the DB when neither specId nor projectId is given', async () => {
    const db = await import('../db/index.js');
    const { handleOpenCommentsReport } = await import('./open-comments-handler.js');

    const result = await handleOpenCommentsReport({});

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.getOpenCommentsReport)).not.toHaveBeenCalled();
  });

  it('errors and skips the DB when BOTH specId and projectId are given', async () => {
    const db = await import('../db/index.js');
    const { handleOpenCommentsReport } = await import('./open-comments-handler.js');

    const result = await handleOpenCommentsReport({ specId: SPEC, projectId: PROJECT });

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.getOpenCommentsReport)).not.toHaveBeenCalled();
  });

  it('calls the report with a spec scope and returns JSON content', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getOpenCommentsReport).mockResolvedValue({
      scope: { kind: 'spec', specId: SPEC },
      openComments: [],
      summary: { open: 0, total: 0 },
    });
    const { handleOpenCommentsReport } = await import('./open-comments-handler.js');

    const result = await handleOpenCommentsReport({ specId: SPEC });

    expect(vi.mocked(db.getOpenCommentsReport)).toHaveBeenCalledWith({
      kind: 'spec',
      specId: SPEC,
    });
    expect(result).not.toHaveProperty('isError');
    const parsed = JSON.parse(result.content[0]?.text ?? '') as { summary: { open: number } };
    expect(parsed.summary.open).toBe(0);
  });

  it('returns isError (never throws) when the report throws SpecNotFoundError', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getOpenCommentsReport).mockRejectedValue(new FakeSpecNotFound('spec missing'));
    const { handleOpenCommentsReport } = await import('./open-comments-handler.js');

    const result = await handleOpenCommentsReport({ specId: SPEC });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain('spec missing');
  });
});
