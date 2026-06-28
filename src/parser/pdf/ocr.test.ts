import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ParserError } from '../error.js';
import { hasLocalTraineddata, recognizePdfPages, type ManagedRecognizer } from './ocr.js';

const NEVER_RESOLVES = (): Promise<ManagedRecognizer> =>
  new Promise<ManagedRecognizer>(() => undefined);

const STUB_RENDER = (): Promise<Buffer> => Promise.resolve(Buffer.alloc(0));

const WORKING_WORKER = (): Promise<ManagedRecognizer> =>
  Promise.resolve<ManagedRecognizer>({
    recognize: () => Promise.resolve({ text: 'PART 1 - GENERAL', confidence: 99 }),
    terminate: () => Promise.resolve(),
  });

describe('recognizePdfPages worker-init bounding (#298)', () => {
  it('ocr: worker init stall rejects with ParserError within timeout, never hangs', async () => {
    const start = Date.now();

    await expect(
      recognizePdfPages(Buffer.from('%PDF'), [1], {
        initTimeoutMs: 50,
        createWorker: NEVER_RESOLVES,
        renderPageAsImage: STUB_RENDER,
      })
    ).rejects.toBeInstanceOf(ParserError);

    // A 50ms init timeout must settle far inside vitest's default 5s test budget;
    // without the bound, the never-resolving factory would hang the whole job.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('ocr: #290 fail-fast preserved — a rejecting worker init still surfaces ParserError', async () => {
    await expect(
      recognizePdfPages(Buffer.from('%PDF'), [1], {
        createWorker: () => Promise.reject(new Error('fetch failed')),
        renderPageAsImage: STUB_RENDER,
      })
    ).rejects.toBeInstanceOf(ParserError);
  });

  it('ocr: a worker that resolves after the timeout is terminated, never leaked', async () => {
    let terminated = false;
    const lateWorker: ManagedRecognizer = {
      recognize: () => Promise.resolve({ text: 'x', confidence: 99 }),
      terminate: () => {
        terminated = true;
        return Promise.resolve();
      },
    };

    await expect(
      recognizePdfPages(Buffer.from('%PDF'), [1], {
        initTimeoutMs: 20,
        createWorker: () =>
          new Promise<ManagedRecognizer>((resolve) => {
            setTimeout(() => resolve(lateWorker), 80);
          }),
        renderPageAsImage: STUB_RENDER,
      })
    ).rejects.toBeInstanceOf(ParserError);

    // The worker resolves ~80ms in — well after the 20ms init timeout fired.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(terminated).toBe(true);
  });
});

describe('recognizePdfPages strict offline mode (#298 worker-leak fix)', () => {
  const ABSENT = (): Promise<boolean> => Promise.resolve(false);
  const PRESENT = (): Promise<boolean> => Promise.resolve(true);

  it('ocr: strict offline + no local traineddata → ParserError WITHOUT spawning a worker', async () => {
    let spawned = false;

    await expect(
      recognizePdfPages(Buffer.from('%PDF'), [1], {
        requireLocalTraineddata: true,
        hasLocalTraineddata: ABSENT,
        createWorker: () => {
          spawned = true;
          return NEVER_RESOLVES();
        },
        renderPageAsImage: STUB_RENDER,
      })
    ).rejects.toBeInstanceOf(ParserError);

    // The leak fix: in the black-hole stall the bounded timeout cannot terminate
    // an already-spawned worker (tesseract.js spawns it before the traineddata
    // fetch). Pre-flight must refuse BEFORE spawning — createWorker never runs.
    expect(spawned).toBe(false);
  });

  it('ocr: strict offline + local traineddata present → proceeds to spawn the worker', async () => {
    let spawned = false;

    const result = await recognizePdfPages(Buffer.from('%PDF'), [1], {
      requireLocalTraineddata: true,
      hasLocalTraineddata: PRESENT,
      createWorker: () => {
        spawned = true;
        return WORKING_WORKER();
      },
      renderPageAsImage: STUB_RENDER,
    });

    expect(spawned).toBe(true);
    expect(result[0]?.text).toContain('GENERAL');
  });
});

describe('hasLocalTraineddata (tesseract.js cache filename contract)', () => {
  it('ocr: detects eng.traineddata in cachePath; false for an empty dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'specr-ocr-cache-'));
    try {
      expect(await hasLocalTraineddata({ cachePath: dir })).toBe(false);
      await writeFile(path.join(dir, 'eng.traineddata'), 'x');
      expect(await hasLocalTraineddata({ cachePath: dir })).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ocr: detects the gzipped eng.traineddata.gz cache variant', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'specr-ocr-cache-'));
    try {
      await writeFile(path.join(dir, 'eng.traineddata.gz'), 'x');
      expect(await hasLocalTraineddata({ cachePath: dir })).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
