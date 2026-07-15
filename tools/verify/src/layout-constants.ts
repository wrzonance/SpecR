// Layout-derivation helper for config.test.ts's viewport-margin invariant
// (issue #150 finding 7): reads public/index.html's ACTUAL CSS rather than
// letting a test carry its own hardcoded copies of the sidebar width and
// pane-column count. Those literals would silently drift from the real
// layout the first time someone widened the sidebar or changed the pane
// count in public/index.html without also updating the test — this module
// is what makes that change fail loudly instead. See layout-constants.test.ts
// (this file's own extraction invariant, proven first) and config.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const HARNESS_INDEX_HTML_PATH = resolve(import.meta.dirname, '..', 'public', 'index.html');

/** Read the harness's shipped page (defaults to the real, on-disk file). */
export function readHarnessIndexHtml(path: string = HARNESS_INDEX_HTML_PATH): string {
  return readFileSync(path, 'utf-8');
}

function extractRuleBody(html: string, selector: string): string {
  const selectorStart = html.indexOf(`${selector} {`);
  if (selectorStart === -1) {
    throw new Error(`layout-constants: no "${selector} {" rule found in public/index.html`);
  }
  const bodyEnd = html.indexOf('}', selectorStart);
  if (bodyEnd === -1) {
    throw new Error(`layout-constants: unterminated "${selector}" rule in public/index.html`);
  }
  return html.slice(selectorStart, bodyEnd);
}

// String-slicing rather than a single regex on purpose: an unanchored
// quantifier directly against arbitrary file content (no literal prefix
// bounding where it can start, e.g. `\s*([^;]+)`) is a real super-linear-
// backtracking risk (flagged by sonarjs/super-linear-regex) once the value
// doesn't end the way the pattern expects. indexOf-based extraction has no
// backtracking at all and reads just as directly.
function extractGridTemplateColumns(html: string, selector: string): string {
  const body = extractRuleBody(html, selector);
  const propertyName = 'grid-template-columns:';
  const declarationStart = body.indexOf(propertyName);
  if (declarationStart === -1) {
    throw new Error(`layout-constants: no grid-template-columns declaration in "${selector}" rule`);
  }
  const valueStart = declarationStart + propertyName.length;
  const valueEnd = body.indexOf(';', valueStart);
  if (valueEnd === -1) {
    throw new Error(
      `layout-constants: unterminated grid-template-columns declaration in "${selector}" rule`
    );
  }
  return body.slice(valueStart, valueEnd).trim();
}

/**
 * The fixed sidebar width (px) from #layout's grid-template-columns
 * ("1fr 320px") — the non-fr column beside the 3-pane grid.
 */
export function extractSidebarWidthPx(html: string): number {
  const columns = extractGridTemplateColumns(html, '#layout');
  const pxToken = columns.split(/\s+/).find((token) => token.endsWith('px'));
  if (pxToken === undefined) {
    throw new Error(`layout-constants: no pixel width found in "#layout" columns "${columns}"`);
  }
  const widthPx = Number(pxToken.slice(0, -'px'.length));
  if (!Number.isFinite(widthPx)) {
    throw new Error(
      `layout-constants: "${pxToken}" is not a numeric pixel width in "#layout" columns`
    );
  }
  return widthPx;
}

/**
 * The number of equal-width pane columns from #panes's grid-template-columns
 * ("repeat(3, 1fr)").
 */
export function extractPaneColumnCount(html: string): number {
  const columns = extractGridTemplateColumns(html, '#panes');
  const repeatPrefix = 'repeat(';
  const repeatStart = columns.indexOf(repeatPrefix);
  if (repeatStart === -1) {
    throw new Error(
      `layout-constants: no repeat(N, ...) count found in "#panes" columns "${columns}"`
    );
  }
  const countStart = repeatStart + repeatPrefix.length;
  const countEnd = columns.indexOf(',', countStart);
  if (countEnd === -1) {
    throw new Error(`layout-constants: malformed repeat(...) in "#panes" columns "${columns}"`);
  }
  const countText = columns.slice(countStart, countEnd).trim();
  const count = Number(countText);
  if (!Number.isFinite(count)) {
    throw new Error(
      `layout-constants: "${countText}" is not a numeric column count in "#panes" columns`
    );
  }
  return count;
}
