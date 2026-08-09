import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

class FakeSpecNotFound extends Error {}
class FakeProjectNotFound extends Error {}

vi.mock('../db/index.js', () => ({
  getTextBoxesReport: vi.fn(),
  SpecNotFoundError: FakeSpecNotFound,
  ProjectNotFoundError: FakeProjectNotFound,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRes(): {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

const SPEC = '10000000-0000-4000-8000-000000000001';
const PROJECT = '20000000-0000-4000-8000-000000000002';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('text-box REST report handlers (#409)', () => {
  it('rejects a malformed spec id before reaching the database', async () => {
    const db = await import('../db/index.js');
    const { getSpecTextBoxesHandler } = await import('./text-boxes.js');
    const response = makeRes();

    await getSpecTextBoxesHandler(
      { params: { id: 'not-a-uuid' } } as unknown as Request,
      response as unknown as Response
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(vi.mocked(db.getTextBoxesReport)).not.toHaveBeenCalled();
  });

  it('returns the report payload at project scope', async () => {
    const db = await import('../db/index.js');
    const report = {
      scope: { kind: 'project' as const, projectId: PROJECT },
      textBoxes: [],
      summary: { textBoxes: 0 },
    };
    vi.mocked(db.getTextBoxesReport).mockResolvedValue(report);
    const { getProjectTextBoxesHandler } = await import('./text-boxes.js');
    const response = makeRes();

    await getProjectTextBoxesHandler(
      { params: { id: PROJECT } } as unknown as Request,
      response as unknown as Response
    );

    expect(vi.mocked(db.getTextBoxesReport)).toHaveBeenCalledWith({
      kind: 'project',
      projectId: PROJECT,
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ success: true, data: report });
  });

  it('maps an unknown spec to 404 without leaking database details', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getTextBoxesReport).mockRejectedValue(new FakeSpecNotFound('spec missing'));
    const { getSpecTextBoxesHandler } = await import('./text-boxes.js');
    const response = makeRes();

    await getSpecTextBoxesHandler(
      { params: { id: SPEC } } as unknown as Request,
      response as unknown as Response
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ success: false, error: 'spec missing' });
  });
});
