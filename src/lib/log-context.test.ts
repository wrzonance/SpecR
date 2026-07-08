import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Logger } from 'pino';

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
    // exactOptionalPropertyTypes: omitted optional fields must be ABSENT, not `undefined`.
    expect('specId' in (b.doc ?? {})).toBe(false);
    expect('jobId' in (b.doc ?? {})).toBe(false);
  });

  it('includes specId when provided', async () => {
    const { parseLog } = await import('./log-context.js');
    const child = parseLog({ filename: 'a.docx', sha256: 'x', loader: 'rest:parse', specId: 's1' });
    expect((child.bindings() as { doc?: { specId?: string } }).doc?.specId).toBe('s1');
  });
});

describe('logParseWarnings', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  });

  it('emits the parse-warning event on the given logger when warnings are present', async () => {
    const { logParseWarnings } = await import('./log-context.js');
    const warn = vi.fn();
    const log = { warn } as unknown as Logger;
    const warnings = [{ type: 'unusual-part-count' as const, suggestion: 's' }];
    logParseWarnings(log, warnings);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ warnings }, 'parse produced warnings');
  });

  it('is a no-op (never logs) when the warnings array is empty', async () => {
    const { logParseWarnings } = await import('./log-context.js');
    const warn = vi.fn();
    const log = { warn } as unknown as Logger;
    logParseWarnings(log, []);
    expect(warn).not.toHaveBeenCalled();
  });
});
