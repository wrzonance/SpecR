import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ast/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ast/index.js')>();
  return {
    ...actual,
    parseSourceFacts: vi.fn((raw: unknown) => raw),
    SourceFactsSchema: { parse: vi.fn((raw: unknown) => raw) },
  };
});

function makeDb() {
  const query = vi.fn((sql: string) => {
    if (sql.startsWith('BEGIN') || sql === 'COMMIT')
      return Promise.resolve({ rows: [], rowCount: 0 });
    if (sql.includes('FROM specs WHERE id = $1'))
      return Promise.resolve({ rows: [{ exists: 1 }], rowCount: 1 });
    if (sql.includes('FROM projects WHERE id = $1'))
      return Promise.resolve({ rows: [{ exists: 1 }], rowCount: 1 });
    return Promise.resolve({
      rows: [
        {
          paragraphId: 'para-1',
          specId: 'spec-1',
          specSection: '07 92 00',
          sourceFacts: {
            comments: [{ author: 'Alex', text: 'Coordinate.', anchor: [0, 4], closed: false }],
          },
        },
      ],
      rowCount: 1,
    });
  });
  const release = vi.fn();
  return { db: { connect: vi.fn(() => Promise.resolve({ query, release })) }, query, release };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('getOpenCommentsReport review feedback', () => {
  it('uses parseSourceFacts and filters spec-scope rows to source facts with comments', async () => {
    const { parseSourceFacts, SourceFactsSchema } = await import('../../ast/index.js');
    const { getOpenCommentsReport } = await import('./open-comments.js');
    const { db, query } = makeDb();

    await getOpenCommentsReport({ kind: 'spec', specId: 'spec-1' }, db as never);

    expect(parseSourceFacts).toHaveBeenCalledWith({
      comments: [{ author: 'Alex', text: 'Coordinate.', anchor: [0, 4], closed: false }],
    });
    expect(SourceFactsSchema.parse).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes(`p.source_facts ? 'comments'`))
    ).toBe(true);
  });

  it('filters project-scope rows to source facts with comments', async () => {
    const { getOpenCommentsReport } = await import('./open-comments.js');
    const { db, query } = makeDb();

    await getOpenCommentsReport({ kind: 'project', projectId: 'project-1' }, db as never);

    expect(
      query.mock.calls.some(([sql]) => String(sql).includes(`p.source_facts ? 'comments'`))
    ).toBe(true);
  });
});
