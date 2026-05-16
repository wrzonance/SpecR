import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../parser/index.js', () => ({ parse: vi.fn() }));
vi.mock('../db/index.js', () => ({ persistParsedSpec: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import { loadFiles } from './file-loader.js';
import { parse } from '../parser/index.js';
import { persistParsedSpec } from '../db/index.js';
import { readFile } from 'node:fs/promises';
import type { CsiTree } from '../ast/types.js';

const mockTree: CsiTree = { id: 'x', section: '27 10 00', title: 'T', parts: [] };
const mockBuf = Buffer.from('data');

beforeEach(() => vi.clearAllMocks());

describe('loadFiles()', () => {
  it('returns zero-result for empty path list', async () => {
    const result = await loadFiles([]);
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0, errors: [] });
    expect(parse).not.toHaveBeenCalled();
  });

  it('succeeds when parse and persist both succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-1');

    const result = await loadFiles(['/a/spec.sec']);

    expect(result).toEqual({ total: 1, succeeded: 1, failed: 0, errors: [] });
  });

  it('isolates parse failure — other files still succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse)
      .mockRejectedValueOnce(new Error('bad xml'))
      .mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-2');

    const result = await loadFiles(['/a/bad.sec', '/b/good.sec']);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe('/a/bad.sec');
    expect(result.errors[0]?.error).toBe('bad xml');
  });

  it('isolates persistParsedSpec failure', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockRejectedValue(new Error('db down'));

    const result = await loadFiles(['/a/spec.sec']);

    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error).toBe('db down');
  });

  it('isolates readFile ENOENT failure', async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('no such file'), { code: 'ENOENT' })
    );

    const result = await loadFiles(['/missing/spec.sec']);

    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error).toContain('no such file');
  });

  it('skips persistParsedSpec when dryRun is true', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });

    const result = await loadFiles(['/a/spec.sec'], { dryRun: true });

    expect(persistParsedSpec).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(1);
  });

  it('calls onProgress once per file with correct args', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockResolvedValue('id');

    const calls: [number, number, string, boolean][] = [];
    await loadFiles(['/a/spec.sec', '/b/spec.sec'], {
      onProgress: (done, total, file, ok) => calls.push([done, total, file, ok]),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([1, 2, '/a/spec.sec', true]);
    expect(calls[1]).toEqual([2, 2, '/b/spec.sec', true]);
  });

  it('onProgress receives ok=false on failure', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('boom'));

    const okValues: boolean[] = [];
    await loadFiles(['/a/spec.sec'], {
      onProgress: (_d, _t, _f, ok) => okValues.push(ok),
    });

    expect(okValues).toEqual([false]);
  });
});
