// Region cropping for the visual round-trip verification harness (#150,
// task 5/8). Crops a rectangular region (page/header/footer) out of a
// full-page screenshot PNG, given geometry captured by the harness page's
// window.__measure() (a later task) — see issue #150's RegionDiff /
// cropRegion contract note.
//
// Source geometry (`pageGeom`/`headerGeom`/`footerGeom`) is
// getBoundingClientRect()-based and therefore VIEWPORT-RELATIVE, not
// document-relative (design decision 3 / WT-150 spike finding 2) — at an
// unpinned viewport, `x`/`y` can be negative or a rect can extend past the
// screenshot docx-preview actually rendered into. This module's bounds
// check is a confirmed load-bearing backstop for that, not defensive
// paranoia: cropRegion throws VerifyRenderError rather than ever producing
// a silently clipped or garbage crop that a later pixel-diff stage could
// mistake for a legitimate comparison. The primary guard is operational —
// the driving agent must pin the capture viewport (>=900px wide, scroll=0,
// see config.ts's VerifyEnv.viewportWidth and the README) before any
// screenshot is taken.

import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { VerifyRenderError } from '../errors.js';

/** A rectangle in viewport pixels, as captured by window.__measure(). */
export interface Geom {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function isOutOfBounds(rect: Geom, sourceWidth: number, sourceHeight: number): boolean {
  return (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > sourceWidth ||
    rect.y + rect.height > sourceHeight
  );
}

function assertWithinBounds(rect: Geom, sourcePath: string, source: PNG): void {
  if (!isOutOfBounds(rect, source.width, source.height)) return;
  throw new VerifyRenderError(
    `crop region ${JSON.stringify(rect)} falls outside ${sourcePath}'s bounds ` +
      `(${String(source.width)}x${String(source.height)}) — is the capture viewport pinned?`,
    { stage: 'render' }
  );
}

/**
 * Crop `rect` out of the PNG at `sourcePath` and write the result to
 * `destPath`. Always bounds-checks `rect` against the source image's actual
 * dimensions first and throws VerifyRenderError — never silently clipping
 * or writing a garbage crop — see this module's docstring.
 */
export async function cropRegion(sourcePath: string, rect: Geom, destPath: string): Promise<void> {
  const source = PNG.sync.read(await readFile(sourcePath));
  assertWithinBounds(rect, sourcePath, source);

  const cropped = new PNG({ width: rect.width, height: rect.height });
  PNG.bitblt(source, cropped, rect.x, rect.y, rect.width, rect.height, 0, 0);
  await writeFile(destPath, PNG.sync.write(cropped));
}
