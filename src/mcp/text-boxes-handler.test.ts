import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeSpecNotFound extends Error {}
class FakeProjectNotFound extends Error {}

vi.mock('../db/index.js', () => ({
  getTextBoxesReport: vi.fn(),
  SpecNotFoundError: FakeSpecNotFound,
  ProjectNotFoundError: FakeProjectNotFound,
}));

const SPEC = '10000000-0000-4000-8000-000000000001';
const PROJECT = '20000000-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('handleTextBoxesReport — scope resolution (#409)', () => {
  it('rejects missing and ambiguous scopes without reaching the database', async () => {
    const db = await import('../db/index.js');
    const { handleTextBoxesReport } = await import('./text-boxes-handler.js');

    expect(await handleTextBoxesReport({})).toMatchObject({ isError: true });
    expect(await handleTextBoxesReport({ specId: SPEC, projectId: PROJECT })).toMatchObject({
      isError: true,
    });
    expect(vi.mocked(db.getTextBoxesReport)).not.toHaveBeenCalled();
  });

  it('returns the scoped report as JSON content', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getTextBoxesReport).mockResolvedValue({
      scope: { kind: 'spec', specId: SPEC },
      textBoxes: [],
      summary: { textBoxes: 0 },
    });
    const { handleTextBoxesReport } = await import('./text-boxes-handler.js');

    const result = await handleTextBoxesReport({ specId: SPEC });

    expect(vi.mocked(db.getTextBoxesReport)).toHaveBeenCalledWith({
      kind: 'spec',
      specId: SPEC,
    });
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      summary: { textBoxes: 0 },
    });
  });

  it('returns isError for scope-specific not-found errors and never throws', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getTextBoxesReport).mockRejectedValue(new FakeProjectNotFound('project missing'));
    const { handleTextBoxesReport } = await import('./text-boxes-handler.js');

    const result = await handleTextBoxesReport({ projectId: PROJECT });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain('project missing');
  });
});
