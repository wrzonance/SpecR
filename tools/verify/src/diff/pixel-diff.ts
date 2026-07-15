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

async function diffRegion(
  differ: PixelDiffer,
  input: RegionDiffInput,
  geom: Geom,
  regionName: string
): Promise<PixelDiffResult> {
  const referenceCrop = path.join(input.workDir, `${regionName}-reference.png`);
  const roundtripCrop = path.join(input.workDir, `${regionName}-roundtrip.png`);
  const diffOut = path.join(input.workDir, `${regionName}-diff.png`);

  await Promise.all([
    cropRegion(input.referenceScreenshotPath, geom, referenceCrop),
    cropRegion(input.roundtripScreenshotPath, geom, roundtripCrop),
  ]);
  return differ.diff(referenceCrop, roundtripCrop, diffOut);
}

async function diffOptionalRegion(
  differ: PixelDiffer,
  input: RegionDiffInput,
  geom: Geom | null,
  regionName: string
): Promise<PixelDiffResult | null> {
  return geom === null ? null : diffRegion(differ, input, geom, regionName);
}

/**
 * Crop and diff a run's page/header/footer regions. See RegionDiffSet's
 * docstring for the null-iff-absent invariant on header/footer.
 */
export async function diffRegions(
  differ: PixelDiffer,
  input: RegionDiffInput
): Promise<RegionDiffSet> {
  const [page, header, footer] = await Promise.all([
    diffRegion(differ, input, input.pageGeom, 'page'),
    diffOptionalRegion(differ, input, input.headerGeom, 'header'),
    diffOptionalRegion(differ, input, input.footerGeom, 'footer'),
  ]);
  return { page, header, footer };
}
