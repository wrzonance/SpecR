import { describe, it, expect, beforeAll } from 'vitest';

describe('parseLog', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  });

  it('binds document context under an app-controlled `doc` key', async () => {
    const { parseLog } = await import('./log-context.js');
    const child = parseLog({ filename: 'a.docx', sha256: 'deadbeef', loader: 'load_files' });
    const b = child.bindings() as { doc?: { sha256?: string; filename?: string } };
    expect(b.doc?.sha256).toBe('deadbeef');
    expect(b.doc?.filename).toBe('a.docx');
  });

  it('includes specId when provided', async () => {
    const { parseLog } = await import('./log-context.js');
    const child = parseLog({ filename: 'a.docx', sha256: 'x', loader: 'rest:parse', specId: 's1' });
    expect((child.bindings() as { doc?: { specId?: string } }).doc?.specId).toBe('s1');
  });
});
