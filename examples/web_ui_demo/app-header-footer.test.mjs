// Source-contract test for app.js's header/footer wiring (#477, task 10/11).
// app.js is the demo's entry point: it reads real DOM elements at MODULE
// SCOPE (`const board = document.getElementById('spec-board')`, line ~82),
// so — unlike editor.js's exported appendHeaderFooterSummary — it cannot be
// imported in plain Node without a document global (no jsdom in this repo;
// confirmed: `node --input-type=module -e "import './js/app.js'"` throws
// `ReferenceError: document is not defined`). No test file in this demo
// imports app.js for that reason.
//
// What IS a real regression risk, and worth pinning, is app.js's *wiring
// contract* with header-footer.js and editor.js — the same class of gap
// header-footer-markup.test.mjs already catches for index.html's static
// markup. This file applies that same source-contract approach to app.js's
// source text.
//
// Pins the two invariants from this task's TDD instruction, both real gaps a
// careless edit could reintroduce silently (no runtime error — the panel
// would just misbehave or 400):
//   1. getSelectedLibraryTier is normalized with an explicit `?? null` —
//      `selectedLibrary()?.tier` ALONE yields `undefined` when nothing is
//      selected, which is not a legal value in header-footer.js's documented
//      'reference'|'company'|'client'|null contract, and its own tier gate
//      (`=== 'client'`) happens to reject `undefined` too — so this exact
//      bug would NOT throw or 400 anywhere; it would just silently pass the
//      gate test as false and look correct by accident. `?? null` is what
//      makes the contract explicit rather than incidental.
//   2. Client-scope header/footer calls (refreshLibraryPanel) fire only
//      through paths gated on the selected library's tier — never
//      unconditionally — mirrored here by requiring every wiring call site
//      to route through headerFooterPanel (itself internally gated, see
//      header-footer.test.mjs's own invariant 3), never a bare
//      getClientHeaderFooter-style call app.js would have to gate itself.
//
// Where behavior is genuinely DOM-free — normalizeUuidInput — it lives in its
// own pure module (js/uuid-input.mjs) with a real runtime test
// (uuid-input.test.mjs) instead of a source-text regex here; this file only
// pins that app.js still imports it. The remaining #481 tests below
// (initPackageRevisionHeaderFooter's ctx getters, the id-input change
// listeners) stay source-anchored because they close over app.js's own
// module-scope DOM elements and state, which this repo's jsdom-free test
// setup cannot exercise at runtime — see each test's own comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./js/app.js', import.meta.url)), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `expected a function named ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unterminated function body for ${name}`);
}

test('imports initHeaderFooter from header-footer.js', () => {
  assert.match(source, /import\s*\{\s*initHeaderFooter\s*\}\s*from\s*'\.\/header-footer\.js';/);
});

test('getSelectedLibraryTier is normalized with an explicit `?? null` — never bare selectedLibrary()?.tier', () => {
  // Scoped to the initHeaderFooter({ ... }) call site — mirrors the
  // "initEditor is wired..." check below — rather than a bare source-wide
  // regex.match, which would equally match an unrelated occurrence of this
  // exact text elsewhere in this 2600+ line file, and would NOT fail if the
  // expression were extracted out of this call site into a differently-named
  // helper that still normalizes to null correctly.
  const initHeaderFooterStart = source.indexOf('headerFooterPanel = initHeaderFooter({');
  assert.ok(initHeaderFooterStart > -1, 'expected the initHeaderFooter(...) call site');
  const callEnd = source.indexOf('});', initHeaderFooterStart);
  const call = source.slice(initHeaderFooterStart, callEnd);
  assert.match(
    call,
    /getSelectedLibraryTier:\s*\(\)\s*=>\s*selectedLibrary\(\)\?\.tier\s*\?\?\s*null/,
    'header-footer.js documents this ctx field as ALREADY normalized to null — selectedLibrary()?.tier alone can be undefined'
  );
});

test('showView(): entering "library" refreshes the client-scope header/footer panel', () => {
  const body = functionBody('showView');
  assert.match(body, /if\s*\(view === 'library'\)\s*void headerFooterPanel\?\.refreshLibraryPanel\(\);/);
});

test('showView(): entering "settings" refreshes the project-scope header/footer panel', () => {
  const body = functionBody('showView');
  assert.match(body, /if\s*\(view === 'settings'\)\s*void headerFooterPanel\?\.refreshProjectPanel\(\);/);
});

test('renderLibraryDetail() (the client-library-selection change handler) refreshes the client-scope panel on every selection', () => {
  const body = functionBody('renderLibraryDetail');
  assert.match(
    body,
    /void headerFooterPanel\?\.refreshLibraryPanel\(\);/,
    'a library switch must repaint the panel without requiring a view switch'
  );
});

test('renderLibraryDetail() gates the panel wrapper on tier === "client", mirroring the server-side requireClientLibrary gate', () => {
  const body = functionBody('renderLibraryDetail');
  // Anchored to the FULL `hfPanel.hidden = !( ... );` assignment — not just
  // the bare condition substring. A regex that only matched
  // `API_FEATURES.headerFooter && library?.tier === 'client'` would still
  // match a mutant that dropped the leading `!(`/closing `)`
  // (`hfPanel.hidden = (API_FEATURES.headerFooter && library?.tier ===
  // 'client');`), which INVERTS the panel's visibility — it would render
  // (empty) for reference/company libraries and stay hidden for client
  // libraries, the exact tier this feature targets — while the unanchored
  // regex kept passing, because the negation sits outside the matched
  // substring. No other test in the suite exercises this dynamic
  // hidden-toggle: header-footer-markup.test.mjs only checks index.html's
  // static initial `hidden` attribute, and header-footer.test.mjs's
  // tier-gating tests cover the separate API-call gate inside
  // refreshLibraryPanel, not this visual wrapper toggle.
  assert.match(
    body,
    /hfPanel\.hidden = !\(API_FEATURES\.headerFooter && library\?\.tier === 'client'\);/
  );
});

test('initEditor is wired with mountHeaderFooterInspector from the header/footer panel', () => {
  const initEditorStart = source.indexOf('editorPanel = initEditor({');
  assert.ok(initEditorStart > -1, 'expected the initEditor(...) call site');
  const callEnd = source.indexOf('});', initEditorStart);
  const call = source.slice(initEditorStart, callEnd);
  assert.match(call, /mountHeaderFooterInspector:\s*headerFooterPanel\.mountInspector,/);
});

test('headerFooterPanel is constructed before editorPanel — mountInspector must exist when initEditor reads it', () => {
  const hfIndex = source.indexOf('headerFooterPanel = initHeaderFooter({');
  const editorIndex = source.indexOf('editorPanel = initEditor({');
  assert.ok(hfIndex > -1 && editorIndex > -1);
  assert.ok(hfIndex < editorIndex, 'initHeaderFooter must run before initEditor reads headerFooterPanel.mountInspector');
});

// ── Package/revision header-footer wiring (#481, task 8/9) ─────────────────
//
// header-footer-package-revision.js's own test suite pins the module's
// internal behavior (guard independence, CRUD-only package panel, Download
// DOCX). What is NOT covered anywhere else, and is the real regression risk
// of THIS task, is app.js's wiring contract: the ctx object it hands to
// initPackageRevisionHeaderFooter, and the UUID-input change listeners that
// keep selectedPackageId/selectedRevisionId in sync and trigger a repaint.

test('imports initPackageRevisionHeaderFooter from header-footer-package-revision.js', () => {
  assert.match(
    source,
    /import\s*\{\s*initPackageRevisionHeaderFooter\s*\}\s*from\s*'\.\/header-footer-package-revision\.js';/
  );
});

function callSite(marker) {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `expected the ${marker} call site`);
  const end = source.indexOf('});', start);
  assert.ok(end > -1, `expected a terminating "});" for ${marker}`);
  return source.slice(start, end);
}

// Source-text anchored, not runtime — same constraint as the whole file (see
// header comment above): initPackageRevisionHeaderFooter's ctx getters close
// over app.js's module-scope `selectedPackageId`/`selectedRevisionId`, which
// only exist once app.js is loaded in a real `document`. A rename of either
// variable would need this regex updated even with no behavior change; that
// is the accepted trade-off, not an oversight (see how normalizeUuidInput was
// pulled out to its own DOM-free module + real runtime test in
// uuid-input.test.mjs specifically so it did NOT need this treatment).
test('initPackageRevisionHeaderFooter is wired with independent package/revision id getters', () => {
  const call = callSite('packageRevisionHeaderFooterPanel = initPackageRevisionHeaderFooter({');
  assert.match(call, /getSelectedPackageId:\s*\(\)\s*=>\s*selectedPackageId,/);
  assert.match(call, /getSelectedRevisionId:\s*\(\)\s*=>\s*selectedRevisionId,/);
});

test('initPackageRevisionHeaderFooter is wired with all five documented mount points', () => {
  const call = callSite('packageRevisionHeaderFooterPanel = initPackageRevisionHeaderFooter({');
  assert.match(
    call,
    /packageEditorContainer:\s*document\.getElementById\('package-header-footer-editor'\),/
  );
  assert.match(
    call,
    /packageResolutionContainer:\s*document\.getElementById\('package-header-footer-resolution'\),/
  );
  assert.match(
    call,
    /revisionEditorContainer:\s*document\.getElementById\('revision-header-footer-editor'\),/
  );
  assert.match(
    call,
    /revisionResolutionContainer:\s*document\.getElementById\('revision-header-footer-resolution'\),/
  );
  assert.match(
    call,
    /revisionDownloadContainer:\s*document\.getElementById\('revision-header-footer-download'\),/
  );
});

// Source-text anchored (see comment on the getters test above): the change
// listeners themselves are DOM event wiring, closing over module-scope
// `selectedPackageId`/`packageRevisionHeaderFooterPanel` — only
// normalizeUuidInput's own logic was extracted for a real runtime test
// (uuid-input.test.mjs); the call-site wiring around it stays source-anchored.
test('package-id-input change listener normalizes with normalizeUuidInput and refreshes only the package panel', () => {
  const body = functionBody('initPackageRevisionIdInputs');
  const packageBlock = body.slice(
    body.indexOf("getElementById('package-id-input')"),
    body.indexOf("getElementById('revision-id-input')")
  );
  assert.match(
    packageBlock,
    /selectedPackageId\s*=\s*normalizeUuidInput\(packageInput\.value\);/
  );
  assert.match(
    packageBlock,
    /void packageRevisionHeaderFooterPanel\?\.refreshPackagePanel\(\);/
  );
  assert.doesNotMatch(
    packageBlock,
    /refreshRevisionPanel/,
    'the package-id-input listener must never trigger a revision-scope refresh'
  );
});

test('revision-id-input change listener normalizes with normalizeUuidInput and refreshes only the revision panel', () => {
  const body = functionBody('initPackageRevisionIdInputs');
  const revisionBlock = body.slice(body.indexOf("getElementById('revision-id-input')"));
  assert.match(
    revisionBlock,
    /selectedRevisionId\s*=\s*normalizeUuidInput\(revisionInput\.value\);/
  );
  assert.match(
    revisionBlock,
    /void packageRevisionHeaderFooterPanel\?\.refreshRevisionPanel\(\);/
  );
  assert.doesNotMatch(
    revisionBlock,
    /refreshPackagePanel/,
    'the revision-id-input listener must never trigger a package-scope refresh'
  );
});

// normalizeUuidInput's own behavior (trim, empty -> null) is pure and DOM-free,
// so it is exercised with a real runtime test in uuid-input.test.mjs instead
// of a source-text regex — this only pins that app.js still wires in THAT
// module's export, not a local reimplementation drifting back in.
test('imports normalizeUuidInput from uuid-input.mjs', () => {
  assert.match(
    source,
    /import\s*\{\s*normalizeUuidInput\s*\}\s*from\s*'\.\/uuid-input\.mjs';/
  );
  assert.doesNotMatch(
    source,
    /function normalizeUuidInput\(/,
    'normalizeUuidInput must not be reimplemented locally now that it lives in uuid-input.mjs'
  );
});

test('initPackageRevisionIdInputs is called during boot, alongside the other init*() wiring calls', () => {
  const body = functionBody('boot');
  assert.match(body, /initPackageRevisionIdInputs\(\);/);
});

test('selectedPackageId/selectedRevisionId start as null (nothing entered on load)', () => {
  assert.match(source, /let selectedPackageId = null;/);
  assert.match(source, /let selectedRevisionId = null;/);
});
