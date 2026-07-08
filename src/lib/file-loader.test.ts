import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../parser/index.js', () => ({ parse: vi.fn() }));
vi.mock('../db/index.js', () => ({
  persistParsedSpec: vi.fn(),
  lookupSpecSectionTitle: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./log-context.js', () => ({ parseLog: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() })) }));

import { loadFiles, fileParseWarnings } from './file-loader.js';
import { parse } from '../parser/index.js';
import { persistParsedSpec, lookupSpecSectionTitle } from '../db/index.js';
import { readFile } from 'node:fs/promises';
import type { SpecTree } from '../ast/types.js';
import type { SectionInference } from './infer-section.js';

const mockTree: SpecTree = { id: 'x', section: '27 10 00', title: 'T', parts: [] };
const mockBuf = Buffer.from('data');

const metadataInference: SectionInference = {
  method: 'metadata',
  confidence: 'high',
  inferredSection: '27 10 00',
  inferredTitle: 'T',
  titleMatch: 'unknown',
};
const contentInference: SectionInference = {
  method: 'content-high',
  confidence: 'high',
  inferredSection: '26 09 33',
  inferredTitle: 'MOTOR CONTROLLERS',
  titleMatch: 'unknown',
};

beforeEach(() => vi.clearAllMocks());

describe('fileParseWarnings', () => {
  it('returns null when the tree has no warnings', () => {
    expect(fileParseWarnings('a.docx', mockTree)).toBeNull();
  });
  it('returns file-scoped warnings when present', () => {
    const w = [{ type: 'unusual-part-count' as const, suggestion: 's' }];
    expect(fileParseWarnings('a.docx', { ...mockTree, warnings: w })).toEqual({
      file: 'a.docx',
      warnings: w,
    });
  });
});

describe('loadFiles()', () => {
  it('returns zero-result for empty path list', async () => {
    const result = await loadFiles([]);
    expect(result).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
      inferenceWarnings: [],
      parseWarnings: [],
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it('succeeds with metadata — no inferenceWarning, no lookup', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: metadataInference,
    });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-1');
    const result = await loadFiles(['/a/spec.sec']);
    expect(result.succeeded).toBe(1);
    expect(result.inferenceWarnings).toHaveLength(0);
    expect(lookupSpecSectionTitle).not.toHaveBeenCalled();
  });

  it('adds inferenceWarning when content-high inference fires', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: contentInference,
    });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-2');
    vi.mocked(lookupSpecSectionTitle).mockResolvedValue('Variable Frequency Motor Controllers');
    const result = await loadFiles(['/a/26_09_33.docx']);
    expect(result.succeeded).toBe(1);
    expect(result.inferenceWarnings).toHaveLength(1);
    const w = result.inferenceWarnings[0];
    expect(w?.inferredSection).toBe('26 09 33');
    expect(w?.standardTitle).toBe('Variable Frequency Motor Controllers');
    expect(w?.confidence).toBe('high');
    expect(w?.titleMatch).toMatch(/^(exact|close|divergent|unknown)$/);
    expect(lookupSpecSectionTitle).toHaveBeenCalledWith('26 09 33');
  });

  it('emits warning with standardTitle:null when csi lookup fails', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: contentInference,
    });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-3');
    vi.mocked(lookupSpecSectionTitle).mockRejectedValue(new Error('db fail'));
    const result = await loadFiles(['/a/spec.docx']);
    expect(result.succeeded).toBe(1);
    expect(result.inferenceWarnings).toHaveLength(1);
    expect(result.inferenceWarnings[0]?.standardTitle).toBeNull();
    expect(result.inferenceWarnings[0]?.titleMatch).toBe('unknown');
  });

  it('no lookup and no warning during dryRun', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: contentInference,
    });
    const result = await loadFiles(['/a/spec.docx'], { dryRun: true });
    expect(persistParsedSpec).not.toHaveBeenCalled();
    expect(lookupSpecSectionTitle).not.toHaveBeenCalled();
    expect(result.inferenceWarnings).toHaveLength(0);
  });

  it('isolates parse failure — other files still succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse)
      .mockRejectedValueOnce(new Error('bad xml'))
      .mockResolvedValue({ tree: mockTree, refs: [], sectionInference: metadataInference });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id');
    const result = await loadFiles(['/a/bad.sec', '/b/good.sec']);
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.file).toBe('/a/bad.sec');
    expect(result.inferenceWarnings).toHaveLength(0);
  });

  it('isolates persistParsedSpec failure', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: metadataInference,
    });
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

  it('skips persistParsedSpec when dryRun', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: metadataInference,
    });
    const result = await loadFiles(['/a/spec.sec'], { dryRun: true });
    expect(persistParsedSpec).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(1);
  });

  it('calls onProgress once per file with correct args', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: metadataInference,
    });
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
    await loadFiles(['/a/spec.sec'], { onProgress: (_d, _t, _f, ok) => okValues.push(ok) });
    expect(okValues).toEqual([false]);
  });

  it('passes origin_meta provenance (filename, sha256, loader) to persistParsedSpec (#93)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: metadataInference,
    });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-meta');
    await loadFiles(['/a/b/spec.sec']);
    expect(persistParsedSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        originMeta: {
          filename: 'spec.sec',
          sha256: createHash('sha256').update(mockBuf).digest('hex'),
          loader: 'load_files',
        },
      })
    );
  });

  it('surfaces file-scoped parse warnings in the result and logs them (#422)', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    const warnings = [{ type: 'unusual-part-count' as const }];
    vi.mocked(parse).mockResolvedValue({
      tree: { ...mockTree, warnings },
      refs: [],
      sectionInference: metadataInference,
    });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-warn');
    const { parseLog } = await import('./log-context.js');
    const result = await loadFiles(['/a/spec.sec']);
    expect(result.parseWarnings).toEqual([{ file: '/a/spec.sec', warnings }]);
    expect(vi.mocked(parseLog)).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'spec.sec', loader: 'load_files' })
    );
  });

  it('omits parseWarnings entries for files with no warnings', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({
      tree: mockTree,
      refs: [],
      sectionInference: metadataInference,
    });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-nowarn');
    const result = await loadFiles(['/a/spec.sec']);
    expect(result.parseWarnings).toEqual([]);
  });
});
