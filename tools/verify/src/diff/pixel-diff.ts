// Pixel-diff domain for the visual round-trip verification harness (#150,
// task 5/8): compares a reference render's screenshot against the
// round-tripped one, region by region (page/header/footer).
//
// pixelmatch is ESM-default-only as of v6 — always
// `import pixelmatch from 'pixelmatch'`. Do NOT `require()`/CJS-interop-wrap
// this import: a future "fix" toward CJS interop would silently break under
// this package's NodeNext ESM module resolution (WT-150 spike finding 5).
import pixelmatch from 'pixelmatch';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { cropRegion, type Geom } from '../render/regions.js';

/**
 * Result of comparing one region's two crops. `paddedReference`/
 * `paddedRoundtrip` record whether that side had to be grown to match the
 * other's canvas size before pixelmatch could run — see diffImpl's
 * docstring: a real dimension mismatch (e.g. Letter vs A4 page size) is
 * padded, never treated as a hard failure.
 */
export interface PixelDiffResult {
  readonly diffRatio: number;
  readonly paddedReference: boolean;
  readonly paddedRoundtrip: boolean;
}

export interface PixelDiffer {
  diff(referencePath: string, roundtripPath: string, diffPath: string): Promise<PixelDiffResult>;
}

interface PaddedImage {
  readonly png: PNG;
  readonly padded: boolean;
}

// Grow `png` onto a zero-filled width x height canvas if it doesn't already
// fill one exactly. pngjs's PNG constructor zero-initializes `data` via
// Buffer.alloc, so the padded margin is deterministic transparent black —
// never uninitialized memory.
function padToCanvas(png: PNG, width: number, height: number): PaddedImage {
  if (png.width === width && png.height === height) {
    return { png, padded: false };
  }
  const canvas = new PNG({ width, height });
  PNG.bitblt(png, canvas, 0, 0, png.width, png.height, 0, 0);
  return { png: canvas, padded: true };
}

async function readPng(sourcePath: string): Promise<PNG> {
  return PNG.sync.read(await readFile(sourcePath));
}

/**
 * Compare `referencePath` and `roundtripPath`, writing a visual diff image
 * to `diffPath`. Never throws on a canvas-dimension mismatch: both images
 * are padded up to the shared max(width) x max(height) canvas first, so
 * pixelmatch always runs on equal-sized buffers. `diffRatio` is always in
 * [0,1] — mismatched-pixel count divided by total pixel count of that
 * shared canvas.
 */
async function diffImpl(
  referencePath: string,
  roundtripPath: string,
  diffPath: string
): Promise<PixelDiffResult> {
  const [reference, roundtrip] = await Promise.all([
    readPng(referencePath),
    readPng(roundtripPath),
  ]);

  const width = Math.max(reference.width, roundtrip.width);
  const height = Math.max(reference.height, roundtrip.height);
  const paddedReference = padToCanvas(reference, width, height);
  const paddedRoundtrip = padToCanvas(roundtrip, width, height);

  const diffImage = new PNG({ width, height });
  const totalPixels = width * height;
  const numDiffPixels =
    totalPixels === 0
      ? 0
      : pixelmatch(
          paddedReference.png.data,
          paddedRoundtrip.png.data,
          diffImage.data,
          width,
          height
        );

  await writeFile(diffPath, PNG.sync.write(diffImage));

  return {
    diffRatio: totalPixels === 0 ? 0 : numDiffPixels / totalPixels,
    paddedReference: paddedReference.padded,
    paddedRoundtrip: paddedRoundtrip.padded,
  };
}

/** Create a PixelDiffer. No configuration today — a factory for parity with this package's other createX() constructors and to leave room for future options (threshold, etc.) without breaking callers. */
export function createPixelDiffer(): PixelDiffer {
  return { diff: diffImpl };
}

/**
 * Geometry for one screenshot's page/header/footer regions, as captured by
 * the harness page's window.__measure() (a later task). `headerGeom`/
 * `footerGeom` are null when that region doesn't exist on the page (e.g. no
 * running header/footer defined) — see RegionDiffSet's docstring for the
 * invariant this implies.
 *
 * COORDINATE CONTRACT (load-bearing for the future capture-wiring task):
 * a SINGLE `pageGeom`/`headerGeom`/`footerGeom` locates the same logical
 * region in BOTH `referenceScreenshotPath` and `roundtripScreenshotPath`, so
 * the two screenshots must share one coordinate system. In the shipped 3-pane
 * layout the reference and round-trip panes sit in different grid columns, so
 * their raw viewport-relative window.__measure() rects have DIFFERENT `x` —
 * feeding either pane's viewport geometry here as-is would crop the wrong
 * area out of the other screenshot. The capturing agent must therefore supply
 * pane-local captures + pane-local geometry (or otherwise normalize both
 * screenshots to a shared origin) before calling diffRegions().
 */
export interface RegionDiffInput {
  readonly referenceScreenshotPath: string;
  readonly roundtripScreenshotPath: string;
  /** Directory region crops and diff images are written into. */
  readonly workDir: string;
  readonly pageGeom: Geom;
  readonly headerGeom: Geom | null;
  readonly footerGeom: Geom | null;
}

/**
 * Region-by-region diff of one run's reference vs. roundtrip screenshots.
 * `header`/`footer` are null if and only if the corresponding geometry
 * (`headerGeom`/`footerGeom`) was absent from RegionDiffInput — there is no
 * other reason for either to be null, and `page` is never null.
 */
export interface RegionDiffSet {
  readonly page: PixelDiffResult;
  readonly header: PixelDiffResult | null;
  readonly footer: PixelDiffResult | null;
}

/** A geometry pair with one Geom per side — the resolved shape a crop-and-diff always operates on (never a raw nullable pair). */
interface DualGeom {
  readonly reference: Geom;
  readonly roundtrip: Geom;
}

// Crop `referencePath`/`roundtripPath` at their own (possibly distinct)
// resolved geometries and diff the crops. The one shared primitive behind
// diffPageRegion/diffRegionPair/diffRegions/diffPaneRegions — every path
// that ends up producing a PixelDiffResult funnels through here so the
// crop-file-naming convention (`{regionName}-{side}.png`) stays in one
// place.
async function diffCroppedPair(
  differ: PixelDiffer,
  referencePath: string,
  roundtripPath: string,
  workDir: string,
  geoms: DualGeom,
  regionName: string
): Promise<PixelDiffResult> {
  const referenceCrop = path.join(workDir, `${regionName}-reference.png`);
  const roundtripCrop = path.join(workDir, `${regionName}-roundtrip.png`);
  const diffOut = path.join(workDir, `${regionName}-diff.png`);

  await Promise.all([
    cropRegion(referencePath, geoms.reference, referenceCrop),
    cropRegion(roundtripPath, geoms.roundtrip, roundtripCrop),
  ]);
  return differ.diff(referenceCrop, roundtripCrop, diffOut);
}

/**
 * Resolve a region's two per-side geometries into the single DualGeom every
 * crop-and-diff operates on:
 *  - both absent -> null (region doesn't exist on either side — skip it,
 *    same as today's diffOptionalRegion behavior).
 *  - both present -> passed through UNMERGED, one geometry per side (the
 *    normal case: reference and roundtrip panes sit at different screen
 *    coordinates, see PaneDiffInput's docstring).
 *  - exactly one present -> the absent side is cropped at the PRESENT
 *    side's own geometry, not skipped. This makes a missing region diff
 *    loudly against whatever pixels the other render actually has there,
 *    rather than silently reporting "no diff to show" — see
 *    diffPaneRegions' docstring for why that matters for this harness's
 *    default-vs-missing-header/footer fixtures.
 */
export function resolveDualGeom(reference: Geom | null, roundtrip: Geom | null): DualGeom | null {
  if (reference !== null && roundtrip !== null) return { reference, roundtrip };
  if (reference !== null) return { reference, roundtrip: reference };
  if (roundtrip !== null) return { reference: roundtrip, roundtrip };
  return null;
}

/**
 * Crop and diff the page region. Always non-null — page geometry is
 * required on both sides, unlike header/footer — kept as its own helper
 * (rather than routed through diffRegionPair's nullable-typed path) so
 * satisfying RegionDiffSet.page's non-null type never needs a runtime throw
 * that could only ever be dead code (WT-305 spike finding 6).
 */
async function diffPageRegion(
  differ: PixelDiffer,
  referencePath: string,
  roundtripPath: string,
  workDir: string,
  geoms: DualGeom
): Promise<PixelDiffResult> {
  return diffCroppedPair(differ, referencePath, roundtripPath, workDir, geoms, 'page');
}

/**
 * Crop and diff an optional (header/footer) region. Null iff BOTH sides'
 * input Geom were null — see resolveDualGeom's docstring for the
 * one-side-present fallback.
 */
async function diffRegionPair(
  differ: PixelDiffer,
  referencePath: string,
  roundtripPath: string,
  workDir: string,
  geoms: { reference: Geom | null; roundtrip: Geom | null },
  regionName: string
): Promise<PixelDiffResult | null> {
  const resolved = resolveDualGeom(geoms.reference, geoms.roundtrip);
  return resolved === null
    ? null
    : diffCroppedPair(differ, referencePath, roundtripPath, workDir, resolved, regionName);
}

/**
 * Crop and diff a run's page/header/footer regions. See RegionDiffSet's
 * docstring for the null-iff-absent invariant on header/footer.
 *
 * Implemented as a thin wrapper over diffPageRegion/diffRegionPair, giving
 * BOTH sides the SAME geometry (this input carries only one geometry per
 * region, not a per-side pair) — behaviorally identical to the pre-#305
 * implementation: resolveDualGeom(g, g) always passes `g` through for both
 * sides, and resolveDualGeom(null, null) always skips, exactly like the old
 * diffOptionalRegion.
 */
export async function diffRegions(
  differ: PixelDiffer,
  input: RegionDiffInput
): Promise<RegionDiffSet> {
  const { referenceScreenshotPath: refPath, roundtripScreenshotPath: rtPath, workDir } = input;
  const [page, header, footer] = await Promise.all([
    diffPageRegion(differ, refPath, rtPath, workDir, {
      reference: input.pageGeom,
      roundtrip: input.pageGeom,
    }),
    diffRegionPair(
      differ,
      refPath,
      rtPath,
      workDir,
      { reference: input.headerGeom, roundtrip: input.headerGeom },
      'header'
    ),
    diffRegionPair(
      differ,
      refPath,
      rtPath,
      workDir,
      { reference: input.footerGeom, roundtrip: input.footerGeom },
      'footer'
    ),
  ]);
  return { page, header, footer };
}

/**
 * One side's (reference or roundtrip) page/header/footer geometry, all
 * relative to that side's OWN `screenshotPath` — see PaneDiffInput's
 * docstring for why reference and roundtrip need independent geometries
 * rather than the single shared set RegionDiffInput carries.
 */
export interface PaneRegions {
  readonly screenshotPath: string;
  readonly pageGeom: Geom;
  readonly headerGeom: Geom | null;
  readonly footerGeom: Geom | null;
}

/**
 * Input to diffPaneRegions: unlike RegionDiffInput (one geometry set shared
 * by both screenshots, historically true because a single measurement pass
 * covered same-origin screenshots), the shipped 3-pane layout's reference
 * and round-trip panes sit in DIFFERENT grid columns — see diffRegions'
 * RegionDiffInput docstring on that coordinate contract. A pane-local
 * capture pairs each screenshot with its OWN geometry so the two panes
 * never need to share one coordinate system.
 */
export interface PaneDiffInput {
  readonly reference: PaneRegions;
  readonly roundtrip: PaneRegions;
  /** Directory region crops and diff images are written into. */
  readonly workDir: string;
}

/**
 * Crop and diff a run's page/header/footer regions from two INDEPENDENTLY
 * positioned pane screenshots — the dual-geometry counterpart to
 * diffRegions. See RegionDiffSet's docstring for the null-iff-absent
 * invariant on header/footer (here: null iff BOTH sides' Geom were null).
 */
export async function diffPaneRegions(
  differ: PixelDiffer,
  input: PaneDiffInput
): Promise<RegionDiffSet> {
  const { reference, roundtrip, workDir } = input;
  const [page, header, footer] = await Promise.all([
    diffPageRegion(differ, reference.screenshotPath, roundtrip.screenshotPath, workDir, {
      reference: reference.pageGeom,
      roundtrip: roundtrip.pageGeom,
    }),
    diffRegionPair(
      differ,
      reference.screenshotPath,
      roundtrip.screenshotPath,
      workDir,
      { reference: reference.headerGeom, roundtrip: roundtrip.headerGeom },
      'header'
    ),
    diffRegionPair(
      differ,
      reference.screenshotPath,
      roundtrip.screenshotPath,
      workDir,
      { reference: reference.footerGeom, roundtrip: roundtrip.footerGeom },
      'footer'
    ),
  ]);
  return { page, header, footer };
}
