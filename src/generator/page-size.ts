import type { PageSize } from '../ast/index.js';

/**
 * US Letter (12240x15840 twips, portrait) — the generator's default page
 * size whenever a `SpecTree` carries no captured `pageSize` (#509): a .SEC
 * source (no OOXML `w:pgSz` to capture at all), or a DOCX source whose body
 * `sectPr` genuinely lacked one. Without this default, dolanmiu/docx falls
 * back to its own implicit A4 (11906x16838) — silently wrong for the vast
 * majority of US AEC source documents.
 */
export const LETTER_PAGE_SIZE: PageSize = {
  width: 12240,
  height: 15840,
  orientation: 'portrait',
};

/**
 * Total, pure: resolves the page size a generated section should use.
 * Never throws, never returns undefined, never returns a partial shape —
 * `pageSize` itself (already all-or-nothing at the AST boundary) or
 * `LETTER_PAGE_SIZE`. The single default path shared by every generator
 * call site (`generateDocx`, `generateManual` per-tree, `generateManual`
 * front matter) so no call site special-cases its own fallback.
 */
export function resolvePageSize(pageSize: PageSize | undefined): PageSize {
  return pageSize ?? LETTER_PAGE_SIZE;
}

/** dolanmiu/docx's `page.size` shape (`Partial<IPageSizeAttributes>`, narrowed
 * to what this generator ever sets). */
export interface PageSizeOption {
  readonly width: number;
  readonly height: number;
  readonly orientation?: 'portrait' | 'landscape';
}

/**
 * Translates a captured `PageSize` — whose `width`/`height` are always the
 * literal, physically-rendered `w:pgSz/@w:w` / `@w:h` values (see `PageSize`'s
 * doc comment) — into the shape dolanmiu/docx's `page.size` expects.
 *
 * docx's own `createPageSize` unconditionally swaps `width`/`height`
 * whenever `orientation` is `'landscape'`: its `width`/`height` parameters
 * are the page's *reference* (portrait-style) dimensions, not the physically
 * rendered ones — orientation alone triggers docx's internal swap. Passing a
 * captured landscape `PageSize` straight through would therefore be swapped
 * *twice* (once already true-to-the-source, once by docx), silently
 * reproducing a portrait-shaped rectangle mislabeled landscape. Swapping
 * once here cancels docx's own swap, so the emitted `w:pgSz` reproduces the
 * captured `w:w`/`w:h` verbatim regardless of orientation.
 */
export function toDocxPageSize(pageSize: PageSize): PageSizeOption {
  const { width, height, orientation } = pageSize;
  const isLandscape = orientation === 'landscape';
  return {
    width: isLandscape ? height : width,
    height: isLandscape ? width : height,
    ...(orientation !== undefined ? { orientation } : {}),
  };
}
