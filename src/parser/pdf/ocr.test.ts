import { describe, expect, it } from 'vitest';
import { ParserError } from '../error.js';
import { recognizePdfPages, type ManagedRecognizer } from './ocr.js';

const NEVER_RESOLVES = (): Promise<ManagedRecognizer> =>
  new Promise<ManagedRecognizer>(() => undefined);

const STUB_RENDER = (): Promise<Buffer> => Promise.resolve(Buffer.alloc(0));

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
