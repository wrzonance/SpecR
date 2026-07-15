// Invariant tests for the pixel-diff domain (#150, task 5/8; #305 dual-geometry
// extension for pane-local header/footer fixtures):
//  - PixelDiffer.diff never throws on a canvas-dimension mismatch — it pads
//    the smaller image and sets paddedReference/paddedRoundtrip, and
//    diffRatio is always in [0,1] (WT-150 spike finding 4: validated against
//    a real Letter-vs-A4 page-size mismatch between the LibreOffice
//    reference render and the generator's round-tripped output — not a
//    contrived one; the mismatch also surfaces a page-size-default bug in
//    the generator, out of scope here and flagged separately).
//  - RegionDiffSet.header / .footer are null if and only if the
//    corresponding page geometry was absent.
//  - resolveDualGeom: null iff BOTH sides are null; passes distinct geoms
//    through unmerged when both present; falls back to the present side's
//    own geometry for BOTH sides when exactly one is present (so a missing
//    region diffs against whatever pixels sit at the other render's same
//    coordinates, rather than being silently skipped).
//  - diffPaneRegions crops each side (reference/roundtrip) at its OWN
//    pane-local geometry — proven with independently-positioned synthetic
//    screenshots, not just same-geometry-on-both-sides fixtures.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPixelDiffer,
  diffPaneRegions,
  diffRegions,
  resolveDualGeom,
  type PaneDiffInput,
  type PaneRegions,
  type RegionDiffInput,
} from './pixel-diff.js';
import type { Geom } from '../render/regions.js';

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

// Paints a solid rectangle in place, for building synthetic pane
// screenshots with distinct header/page/footer regions at arbitrary
// (possibly pane-offset) coordinates. Mutates `png` — the caller always
// starts from a freshly built solidPng background, never a shared fixture.
function paintRegion(png: PNG, rect: Geom, rgb: readonly [number, number, number]): void {
  for (let row = 0; row < rect.height; row += 1) {
    for (let col = 0; col < rect.width; col += 1) {
      const idx = ((rect.y + row) * png.width + (rect.x + col)) * 4;
      png.data[idx] = rgb[0];
      png.data[idx + 1] = rgb[1];
      png.data[idx + 2] = rgb[2];
      png.data[idx + 3] = 255;
    }
  }
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

describe('resolveDualGeom', () => {
  const referenceGeom: Geom = { x: 0, y: 0, width: 100, height: 20 };
  const roundtripGeom: Geom = { x: 10, y: 5, width: 90, height: 18 };

  it('returns null when both sides are absent', () => {
    expect(resolveDualGeom(null, null)).toBeNull();
  });

  it('passes distinct geoms through unmerged when both sides are present', () => {
    expect(resolveDualGeom(referenceGeom, roundtripGeom)).toEqual({
      reference: referenceGeom,
      roundtrip: roundtripGeom,
    });
  });

  it('round-trips an identical geom on both sides unchanged', () => {
    expect(resolveDualGeom(referenceGeom, referenceGeom)).toEqual({
      reference: referenceGeom,
      roundtrip: referenceGeom,
    });
  });

  it('falls back to the reference geometry for BOTH sides when only reference is present', () => {
    expect(resolveDualGeom(referenceGeom, null)).toEqual({
      reference: referenceGeom,
      roundtrip: referenceGeom,
    });
  });

  it('falls back to the roundtrip geometry for BOTH sides when only roundtrip is present', () => {
    expect(resolveDualGeom(null, roundtripGeom)).toEqual({
      reference: roundtripGeom,
      roundtrip: roundtripGeom,
    });
  });
});

describe('diffPaneRegions', () => {
  let workDir: string;
  let referencePaneScreenshot: string;
  let roundtripPaneScreenshot: string;

  const GRAY: readonly [number, number, number] = [220, 220, 220];
  const BLUE: readonly [number, number, number] = [0, 0, 255];
  const GREEN: readonly [number, number, number] = [0, 255, 0];

  // The reference pane's content sits at a different offset than the
  // roundtrip pane's, exactly as the shipped 3-pane layout's grid columns
  // do (see diffRegions' RegionDiffInput docstring on the coordinate
  // contract this is standing in for). Each pane's header/footer are
  // painted the SAME color at its OWN pane-local geometry, so a correct
  // per-side crop must produce a ~zero diff despite the panes' differing
  // absolute coordinates — a shared-geometry crop (the pre-#305 diffRegions
  // behavior) would crop the wrong pixels out of at least one side and fail
  // this. Both canvases are the SAME (deliberately oversized) 200x200 —
  // resolveDualGeom's one-side-present fallback crops BOTH screenshots at
  // whichever side's geometry is present, so every rect used by either side
  // below must stay in-bounds on BOTH canvases, not just its own.
  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'specr-verify-pane-diff-'));
    referencePaneScreenshot = path.join(workDir, 'reference-pane.png');
    roundtripPaneScreenshot = path.join(workDir, 'roundtrip-pane.png');

    const reference = solidPng(200, 200, GRAY);
    paintRegion(reference, { x: 0, y: 0, width: 100, height: 20 }, BLUE);
    paintRegion(reference, { x: 0, y: 130, width: 100, height: 20 }, GREEN);
    writePngFixture(referencePaneScreenshot, reference);

    const roundtrip = solidPng(200, 200, GRAY);
    paintRegion(roundtrip, { x: 20, y: 10, width: 100, height: 20 }, BLUE);
    paintRegion(roundtrip, { x: 20, y: 140, width: 100, height: 20 }, GREEN);
    writePngFixture(roundtripPaneScreenshot, roundtrip);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function baseReference(overrides: Partial<PaneRegions> = {}): PaneRegions {
    return {
      screenshotPath: referencePaneScreenshot,
      pageGeom: { x: 0, y: 0, width: 100, height: 150 },
      headerGeom: { x: 0, y: 0, width: 100, height: 20 },
      footerGeom: { x: 0, y: 130, width: 100, height: 20 },
      ...overrides,
    };
  }

  function baseRoundtrip(overrides: Partial<PaneRegions> = {}): PaneRegions {
    return {
      screenshotPath: roundtripPaneScreenshot,
      pageGeom: { x: 20, y: 10, width: 100, height: 150 },
      headerGeom: { x: 20, y: 10, width: 100, height: 20 },
      footerGeom: { x: 20, y: 140, width: 100, height: 20 },
      ...overrides,
    };
  }

  it('crops each side at its own pane-local geometry, so logically matching regions diff near-zero despite different pane offsets', async () => {
    const input: PaneDiffInput = {
      reference: baseReference(),
      roundtrip: baseRoundtrip(),
      workDir,
    };

    const result = await diffPaneRegions(createPixelDiffer(), input);

    expect(result.page).not.toBeNull();
    expect(result.page.diffRatio).toBe(0);
    expect(result.header).not.toBeNull();
    expect(result.header?.diffRatio).toBe(0);
    expect(result.footer).not.toBeNull();
    expect(result.footer?.diffRatio).toBe(0);
  });

  it('produces a non-null page result even when both header and footer geoms are absent on both sides', async () => {
    const input: PaneDiffInput = {
      reference: baseReference({ headerGeom: null, footerGeom: null }),
      roundtrip: baseRoundtrip({ headerGeom: null, footerGeom: null }),
      workDir,
    };

    const result = await diffPaneRegions(createPixelDiffer(), input);

    expect(result.page).not.toBeNull();
    expect(result.header).toBeNull();
    expect(result.footer).toBeNull();
  });

  it('is non-null for header when only one side carries a headerGeom (the fallback branch), never silently skipped', async () => {
    const input: PaneDiffInput = {
      reference: baseReference(),
      roundtrip: baseRoundtrip({ headerGeom: null }),
      workDir,
    };

    const result = await diffPaneRegions(createPixelDiffer(), input);

    expect(result.header).not.toBeNull();
  });

  it('yields diffRatio > 0 in the one-side-null branch when the absent side has different content at the present side geometry (missing-region regression)', async () => {
    // Roundtrip has no header at all — its top-left 100x20 (the reference's
    // header geometry) is plain page background, not the reference's blue
    // header. resolveDualGeom's fallback crops BOTH sides at the
    // reference's own geometry, so this must diff loudly rather than be
    // skipped as null.
    const input: PaneDiffInput = {
      reference: baseReference(),
      roundtrip: baseRoundtrip({ headerGeom: null }),
      workDir,
    };

    const result = await diffPaneRegions(createPixelDiffer(), input);

    expect(result.header).not.toBeNull();
    expect(result.header?.diffRatio).toBeGreaterThan(0);
  });

  it('is null for footer only when BOTH sides lack a footerGeom', async () => {
    const bothAbsent = await diffPaneRegions(createPixelDiffer(), {
      reference: baseReference({ footerGeom: null }),
      roundtrip: baseRoundtrip({ footerGeom: null }),
      workDir,
    });
    const oneAbsent = await diffPaneRegions(createPixelDiffer(), {
      reference: baseReference({ footerGeom: null }),
      roundtrip: baseRoundtrip(),
      workDir,
    });

    expect(bothAbsent.footer).toBeNull();
    expect(oneAbsent.footer).not.toBeNull();
  });
});
