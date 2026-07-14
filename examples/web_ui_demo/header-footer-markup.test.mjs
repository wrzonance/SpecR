// Static-markup boundary test for the header/footer wiring in index.html
// (#477, task 9/11). No jsdom in this repo — real DOM structure is painted
// by header-footer-editor.js/header-footer-preview-view.js and is untested
// directly (see those files' own module docs). What IS a real regression
// risk, and IS worth pinning here, is the *contract* between this static
// markup and:
//   - header-footer.js's ctx shape (libraryContainer/projectEditorContainer/
//     projectResolutionContainer — dedicated mount points a future app.js
//     task wires via document.getElementById), and
//   - the task instruction that this change adds no new <script> tag and no
//     new nav tab.
// A silently-renamed or removed id here would make app.js's future
// getElementById calls return null with no test ever catching it — this
// file is that catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');

function idAttr(id) {
  const match = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `expected an element with id="${id}"`);
  return match[0];
}

test('header/footer stylesheet is linked in <head>, alongside the existing sheets', () => {
  const headMatch = html.match(/<head>[\s\S]*?<\/head>/);
  assert.ok(headMatch, 'expected a <head> section');
  assert.match(
    headMatch[0],
    /<link rel="stylesheet" href="css\/header-footer\.css" \/>/,
    'expected css/header-footer.css to be linked in <head>'
  );
});

test('Library view: client-scope panel exists, hidden by default (tier-gated by a later app.js task)', () => {
  const panel = idAttr('library-header-footer-panel');
  assert.match(panel, /\bhidden\b/, 'must start hidden — no library is selected on load');
  idAttr('library-header-footer'); // dedicated mount, distinct from the panel wrapper
});

test('Library view: header/footer panel sits inside .library-detail, after .library-tree', () => {
  const detailStart = html.indexOf('class="library-detail"');
  const treeStart = html.indexOf('id="library-tree"', detailStart);
  const panelStart = html.indexOf('id="library-header-footer-panel"', detailStart);
  const detailEnd = html.indexOf('</section>', panelStart);
  assert.ok(detailStart > -1 && treeStart > -1 && panelStart > -1 && detailEnd > -1);
  assert.ok(treeStart < panelStart, 'header/footer panel must come after the library tree');
  assert.ok(panelStart < detailEnd, 'header/footer panel must be inside .library-detail');
});

test('Settings view: project-scope panel exists with distinct editor + resolution mounts', () => {
  idAttr('project-header-footer-panel');
  const editor = idAttr('project-header-footer-editor');
  const resolution = idAttr('project-header-footer-resolution');
  assert.notEqual(editor, resolution, 'editor and resolution must be separate mount points');
});

test('Settings view: header/footer panel sits inside #view-settings, alongside the other settings panels', () => {
  const settingsStart = html.indexOf('id="view-settings"');
  const settingsEnd = html.indexOf('</section>', html.indexOf('project-source-list', settingsStart));
  const panelStart = html.indexOf('id="project-header-footer-panel"', settingsStart);
  assert.ok(settingsStart > -1 && panelStart > -1);
  assert.ok(panelStart > settingsStart, 'panel must be inside the settings view');
});

test('no new <script> tag is added — ESM wiring stays owned by app.js', () => {
  const scriptTags = html.match(/<script[^>]*>[\s\S]*?<\/script>/g) ?? [];
  assert.deepEqual(
    scriptTags,
    ['<script src="/vendor/markdown-it.min.js"></script>', '<script type="module" src="js/app.js"></script>'],
    'expected exactly the two pre-existing <script> tags, unchanged'
  );
});

test('no new nav tab is added for header/footer', () => {
  assert.doesNotMatch(html, /data-view-panel="header-footer"/, 'header/footer is not its own view');
});

test('the read-only inspector mount point is untouched (mountInspector appends into it, never replaces it)', () => {
  idAttr('editor-inspector');
});
