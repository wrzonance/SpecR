// Invariant tests for cropRegion (#150, task 5/8): it always bounds-checks
// the requested rect against the source PNG's actual dimensions and throws
// VerifyRenderError rather than ever silently producing a clipped or
// garbage crop — see regions.ts's docstring on why that backstop is
// confirmed load-bearing, not defensive paranoia (WT-150 spike finding 2:
// docx-preview geometry is viewport-relative, so an unpinned viewport can
// hand cropRegion a rect that doesn't fit the actual screenshot).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VerifyRenderError } from '../errors.js';
import { cropRegion, type Geom } from './regions.js';

function solidPng(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number]
): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return png;
}

function writePngFixture(destPath: string, png: PNG): void {
  writeFileSync(destPath, PNG.sync.write(png));
}

describe('cropRegion', () => {
  let workDir: string;
  let sourcePath: string;
  let destPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'specr-verify-regions-'));
    sourcePath = path.join(workDir, 'source.png');
    destPath = path.join(workDir, 'crop.png');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('crops exactly the requested rect out of the source image', async () => {
    const source = solidPng(20, 20, [0, 0, 0, 255]);
    for (let y = 10; y < 14; y++) {
      for (let x = 10; x < 14; x++) {
        const idx = (source.width * y + x) << 2;
        source.data[idx] = 255;
        source.data[idx + 1] = 255;
        source.data[idx + 2] = 255;
        source.data[idx + 3] = 255;
      }
    }
    writePngFixture(sourcePath, source);

    await cropRegion(sourcePath, { x: 10, y: 10, width: 4, height: 4 }, destPath);

    const cropped = PNG.sync.read(readFileSync(destPath));
    expect(cropped.width).toBe(4);
    expect(cropped.height).toBe(4);
    expect(Array.from(cropped.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it.each<[string, Geom]>([
    ['negative x', { x: -5, y: 0, width: 10, height: 10 }],
    ['negative y', { x: 0, y: -5, width: 10, height: 10 }],
    ['width exceeds source', { x: 0, y: 0, width: 999, height: 10 }],
    ['height exceeds source', { x: 0, y: 0, width: 10, height: 999 }],
    ['rect extends past the right edge', { x: 15, y: 0, width: 10, height: 10 }],
    ['rect extends past the bottom edge', { x: 0, y: 15, width: 10, height: 10 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 10 }],
    ['zero height', { x: 0, y: 0, width: 10, height: 0 }],
    // NaN would pass every range check below (NaN comparisons are all false)
    // and reach pngjs as garbage — reject it at the boundary instead.
    ['NaN x (unrounded/absent geometry)', { x: NaN, y: 0, width: 10, height: 10 }],
    ['fractional width', { x: 0, y: 0, width: 10.5, height: 10 }],
  ])(
    'throws VerifyRenderError rather than clipping or producing a garbage crop (%s)',
    async (_label, rect) => {
      writePngFixture(sourcePath, solidPng(20, 20, [0, 0, 0, 255]));

      await expect(cropRegion(sourcePath, rect, destPath)).rejects.toThrow(VerifyRenderError);
    }
  );

  it('rejects an out-of-bounds rect before writing anything to destPath', async () => {
    writePngFixture(sourcePath, solidPng(20, 20, [0, 0, 0, 255]));

    await expect(
      cropRegion(sourcePath, { x: 0, y: 0, width: 999, height: 999 }, destPath)
    ).rejects.toThrow(VerifyRenderError);
    expect(() => readFileSync(destPath)).toThrow();
  });

  it('wraps a missing/unreadable source file in VerifyRenderError rather than a raw fs error', async () => {
    const missing = path.join(workDir, 'does-not-exist.png');

    await expect(
      cropRegion(missing, { x: 0, y: 0, width: 4, height: 4 }, destPath)
    ).rejects.toThrow(VerifyRenderError);
  });

  it('a rejected crop carries stage "render" and names the offending source path', async () => {
    writePngFixture(sourcePath, solidPng(20, 20, [0, 0, 0, 255]));

    try {
      await cropRegion(sourcePath, { x: 0, y: 0, width: 999, height: 999 }, destPath);
      expect.unreachable('cropRegion should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyRenderError);
      expect((error as VerifyRenderError).stage).toBe('render');
      expect((error as VerifyRenderError).message).toContain(sourcePath);
    }
  });
});
