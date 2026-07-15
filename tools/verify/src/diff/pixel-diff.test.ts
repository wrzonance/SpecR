// Invariant tests for the pixel-diff domain (#150, task 5/8):
//  - PixelDiffer.diff never throws on a canvas-dimension mismatch — it pads
//    the smaller image and sets paddedReference/paddedRoundtrip, and
//    diffRatio is always in [0,1] (WT-150 spike finding 4: validated against
//    a real Letter-vs-A4 page-size mismatch between the LibreOffice
//    reference render and the generator's round-tripped output — not a
//    contrived one; the mismatch also surfaces a page-size-default bug in
//    the generator, out of scope here and flagged separately).
//  - RegionDiffSet.header / .footer are null if and only if the
//    corresponding page geometry was absent.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelDiffer, diffRegions, type RegionDiffInput } from './pixel-diff.js';

function solidPng(width: number, height: number, rgb: readonly [number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return png;
}

function writePngFixture(destPath: string, png: PNG): void {
  writeFileSync(destPath, PNG.sync.write(png));
}

describe('createPixelDiffer', () => {
  let workDir: string;
  let referencePath: string;
  let roundtripPath: string;
  let diffPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'specr-verify-pixel-diff-'));
    referencePath = path.join(workDir, 'reference.png');
    roundtripPath = path.join(workDir, 'roundtrip.png');
    diffPath = path.join(workDir, 'diff.png');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reports 0 diffRatio and no padding for identical images', async () => {
    writePngFixture(referencePath, solidPng(10, 10, [0, 128, 255]));
    writePngFixture(roundtripPath, solidPng(10, 10, [0, 128, 255]));

    const result = await createPixelDiffer().diff(referencePath, roundtripPath, diffPath);

    expect(result).toEqual({ diffRatio: 0, paddedReference: false, paddedRoundtrip: false });
  });

  it('reports a nonzero diffRatio in [0,1] when part of the image differs', async () => {
    const reference = solidPng(10, 10, [0, 0, 0]);
    const roundtrip = solidPng(10, 10, [0, 0, 0]);
    for (let i = 0; i < roundtrip.data.length / 2; i += 4) {
      roundtrip.data[i] = 255;
      roundtrip.data[i + 1] = 255;
      roundtrip.data[i + 2] = 255;
    }
    writePngFixture(referencePath, reference);
    writePngFixture(roundtripPath, roundtrip);

    const result = await createPixelDiffer().diff(referencePath, roundtripPath, diffPath);

    expect(result.diffRatio).toBeGreaterThan(0);
    expect(result.diffRatio).toBeLessThanOrEqual(1);
    expect(result.paddedReference).toBe(false);
    expect(result.paddedRoundtrip).toBe(false);
  });

  it('pads the reference when it is smaller than the roundtrip image, without throwing', async () => {
    writePngFixture(referencePath, solidPng(8, 8, [10, 20, 30]));
    writePngFixture(roundtripPath, solidPng(10, 10, [10, 20, 30]));

    const result = await createPixelDiffer().diff(referencePath, roundtripPath, diffPath);

    expect(result.paddedReference).toBe(true);
    expect(result.paddedRoundtrip).toBe(false);
    expect(result.diffRatio).toBeGreaterThanOrEqual(0);
    expect(result.diffRatio).toBeLessThanOrEqual(1);
  });

  it('pads the roundtrip when it is smaller than the reference image, without throwing', async () => {
    writePngFixture(referencePath, solidPng(10, 10, [10, 20, 30]));
    writePngFixture(roundtripPath, solidPng(8, 8, [10, 20, 30]));

    const result = await createPixelDiffer().diff(referencePath, roundtripPath, diffPath);

    expect(result.paddedReference).toBe(false);
    expect(result.paddedRoundtrip).toBe(true);
    expect(result.diffRatio).toBeGreaterThanOrEqual(0);
    expect(result.diffRatio).toBeLessThanOrEqual(1);
  });

  // Mirrors the real Letter (612x792) vs A4 (595x842) page-size mismatch
  // found in the spike, scaled down for test speed: neither image's width
  // nor height matches the other's, so both sides end up padded once each
  // is grown to the shared max(width) x max(height) canvas.
  it('pads both images on a Letter-vs-A4-shaped mismatch (neither dimension matches), without throwing', async () => {
    writePngFixture(referencePath, solidPng(61, 79, [200, 200, 200]));
    writePngFixture(roundtripPath, solidPng(60, 84, [200, 200, 200]));

    const result = await createPixelDiffer().diff(referencePath, roundtripPath, diffPath);

    expect(result.paddedReference).toBe(true);
    expect(result.paddedRoundtrip).toBe(true);
    expect(result.diffRatio).toBeGreaterThanOrEqual(0);
    expect(result.diffRatio).toBeLessThanOrEqual(1);
  });
});

describe('diffRegions', () => {
  let workDir: string;
  let referenceScreenshotPath: string;
  let roundtripScreenshotPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'specr-verify-region-diff-'));
    referenceScreenshotPath = path.join(workDir, 'reference-screenshot.png');
    roundtripScreenshotPath = path.join(workDir, 'roundtrip-screenshot.png');
    writePngFixture(referenceScreenshotPath, solidPng(100, 150, [220, 220, 220]));
    writePngFixture(roundtripScreenshotPath, solidPng(100, 150, [220, 220, 220]));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function baseInput(overrides: Partial<RegionDiffInput> = {}): RegionDiffInput {
    return {
      referenceScreenshotPath,
      roundtripScreenshotPath,
      workDir,
      pageGeom: { x: 0, y: 0, width: 100, height: 150 },
      headerGeom: null,
      footerGeom: null,
      ...overrides,
    };
  }

  it('is null for header/footer when both geometries are absent, but page is always present', async () => {
    const result = await diffRegions(createPixelDiffer(), baseInput());

    expect(result.page).not.toBeNull();
    expect(result.header).toBeNull();
    expect(result.footer).toBeNull();
  });

  it('produces a header diff exactly when headerGeom is present, footer still null', async () => {
    const result = await diffRegions(
      createPixelDiffer(),
      baseInput({ headerGeom: { x: 0, y: 0, width: 100, height: 20 } })
    );

    expect(result.header).not.toBeNull();
    expect(result.footer).toBeNull();
  });

  it('produces a footer diff exactly when footerGeom is present, header still null', async () => {
    const result = await diffRegions(
      createPixelDiffer(),
      baseInput({ footerGeom: { x: 0, y: 130, width: 100, height: 20 } })
    );

    expect(result.header).toBeNull();
    expect(result.footer).not.toBeNull();
  });

  it('produces both header and footer diffs when both geometries are present', async () => {
    const result = await diffRegions(
      createPixelDiffer(),
      baseInput({
        headerGeom: { x: 0, y: 0, width: 100, height: 20 },
        footerGeom: { x: 0, y: 130, width: 100, height: 20 },
      })
    );

    expect(result.header).not.toBeNull();
    expect(result.footer).not.toBeNull();
  });
});
