import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSubmittalRegister: vi.fn(),
  SubmittalRegisterProjectNotFoundError: class SubmittalRegisterProjectNotFoundError extends Error {},
  SubmittalRegisterSpecNotInProjectError: class SubmittalRegisterSpecNotInProjectError extends Error {},
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const FAKE_PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SPEC_ID = '20000000-0000-4000-8000-000000000002';

describe('handleSubmittalRegister — duplicate specIds', () => {
  it("rejects duplicate specIds with the shared schema's own message, never reaching the DB", async () => {
    const db = await import('../db/index.js');
    const { handleSubmittalRegister } = await import('./submittal-register-handler.js');

    const result = await handleSubmittalRegister({
      projectId: FAKE_PROJECT_ID,
      specIds: [SPEC_ID, SPEC_ID],
    });

    expect('isError' in result && result.isError).toBe(true);
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toBe('specIds must not contain duplicates');
    expect(db.getSubmittalRegister).not.toHaveBeenCalled();
  });

  it('never returns the "specs are not in project" misdiagnosis for duplicate specIds', async () => {
    const db = await import('../db/index.js');
    const { handleSubmittalRegister } = await import('./submittal-register-handler.js');

    const result = await handleSubmittalRegister({
      projectId: FAKE_PROJECT_ID,
      specIds: [SPEC_ID, SPEC_ID],
    });

    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).not.toMatch(/not in project/i);
    expect(db.getSubmittalRegister).not.toHaveBeenCalled();
  });

  it('still succeeds for unique specIds (unchanged behavior)', async () => {
    const db = await import('../db/index.js');
    const { handleSubmittalRegister } = await import('./submittal-register-handler.js');

    vi.mocked(db.getSubmittalRegister).mockResolvedValueOnce({
      projectId: FAKE_PROJECT_ID,
      rows: [],
    } as never);

    const result = await handleSubmittalRegister({
      projectId: FAKE_PROJECT_ID,
      specIds: [SPEC_ID],
    });

    expect('isError' in result).toBe(false);
    expect(db.getSubmittalRegister).toHaveBeenCalledWith(FAKE_PROJECT_ID, [SPEC_ID]);
  });
});
