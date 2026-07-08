import { describe, it, expect, beforeAll } from 'vitest';

// buildParseResponse is a pure builder with no DB/env touch-points, but the
// module it lives in (parse-document-handler.ts) transitively imports
// db/index.js → env.ts, which validates process.env and process.exit(1)s at
// module scope. Set the minimum env before any dynamic import, matching the
// pattern in src/lib/logger.test.ts.
beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
});

describe('buildParseResponse', () => {
  it('includes warnings when the tree carries them', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = {
      id: 'r',
      section: '09 91 23',
      title: 't',
      parts: [],
      warnings: [{ type: 'unusual-part-count' as const }],
    };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'metadata',
        confidence: 'high',
        inferredSection: '',
        inferredTitle: '',
        titleMatch: 'unknown',
      },
      3
    );
    expect(r['warnings']).toHaveLength(1);
    expect(r['sectionInference']).toBeUndefined();
  });

  it('omits warnings when the tree has none', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [] };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'metadata',
        confidence: 'high',
        inferredSection: '',
        inferredTitle: '',
        titleMatch: 'unknown',
      },
      0
    );
    expect(r['warnings']).toBeUndefined();
  });

  it('omits warnings when the tree carries an empty warnings array', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [], warnings: [] };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'metadata',
        confidence: 'high',
        inferredSection: '',
        inferredTitle: '',
        titleMatch: 'unknown',
      },
      0
    );
    expect(r['warnings']).toBeUndefined();
  });

  it('still attaches sectionInference (with note) when method is not metadata', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [] };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'content-high',
        confidence: 'high',
        inferredSection: '26 09 33',
        inferredTitle: 'MOTOR CONTROLLERS',
        titleMatch: 'unknown',
      },
      2
    );
    expect(r['sectionInference']).toMatchObject({ method: 'content-high' });
    expect((r['sectionInference'] as { note: string }).note).toContain('Section metadata missing');
  });
});
