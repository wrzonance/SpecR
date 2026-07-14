// Unit tests for the pure header/footer preview model builder (#477). Run:
//   node --test examples/web_ui_demo/header-footer-preview.test.mjs
// Outside CI (examples/ is not a vitest project) — the demo's own regression
// net for the HTML-approximation preview (the markdown renderer has no page
// chrome, so the demo renders its own — see issue #477's "Preview" scope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFieldDisplay,
  buildPreviewModel,
  summarizeWarnings,
} from './js/header-footer-preview.mjs';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// --- resolveFieldDisplay: generation-only kinds never read field.text -----

for (const kind of ['sectionNumber', 'sectionTitle', 'pageNumber']) {
  test(`resolveFieldDisplay('${kind}') is always status:'generation-only' and never reads field.text`, () => {
    const spoofed = deepFreeze({ kind, text: 'SPOOFED — should never appear' });
    const result = resolveFieldDisplay(spoofed, { date: 'x', projectName: 'x', clientName: 'x' });
    assert.equal(result.status, 'generation-only');
    assert.equal(result.text.includes('SPOOFED'), false);
    assert.ok(result.text.length > 0, 'placeholder must be non-empty');
  });
}

test('resolveFieldDisplay: sectionNumber/sectionTitle/pageNumber ignore previewContext entirely', () => {
  const withoutCtx = resolveFieldDisplay({ kind: 'sectionNumber' });
  const withCtx = resolveFieldDisplay({ kind: 'sectionNumber' }, { sectionNumber: '09 91 26' });
  assert.deepEqual(withoutCtx, withCtx);
});

// --- resolveFieldDisplay: literal ------------------------------------------

test('resolveFieldDisplay: literal with text resolves to that text', () => {
  const result = resolveFieldDisplay({ kind: 'literal', text: 'Confidential' });
  assert.deepEqual(result, { status: 'resolved', text: 'Confidential' });
});

test('resolveFieldDisplay: literal with no text is unavailable, never empty-string', () => {
  const result = resolveFieldDisplay({ kind: 'literal' });
  assert.equal(result.status, 'unavailable');
  assert.notEqual(result.text, '');
  assert.ok(result.text.length > 0);
});

// --- resolveFieldDisplay: previewable identity kinds -----------------------

for (const [kind, ctxKey] of [
  ['date', 'date'],
  ['projectName', 'projectName'],
  ['clientName', 'clientName'],
]) {
  test(`resolveFieldDisplay('${kind}') resolves from previewContext.${ctxKey} when present`, () => {
    const ctx = { [ctxKey]: 'REAL VALUE' };
    const result = resolveFieldDisplay({ kind }, ctx);
    assert.deepEqual(result, { status: 'resolved', text: 'REAL VALUE' });
  });

  test(`resolveFieldDisplay('${kind}') is unavailable (never empty-string) when previewContext.${ctxKey} is absent`, () => {
    const result = resolveFieldDisplay({ kind }, {});
    assert.equal(result.status, 'unavailable');
    assert.notEqual(result.text, '');
  });
}

// --- resolveFieldDisplay: excluded identity kinds — never fabricated -------

for (const kind of [
  'packageName',
  'revisionName',
  'revisionLabel',
  'projectNumber',
  'clientNumber',
]) {
  test(`resolveFieldDisplay('${kind}') is always unavailable — excluded from PreviewFieldContext even if a caller mistakenly supplies it`, () => {
    const spoofedCtx = deepFreeze({ [kind]: 'SHOULD NEVER APPEAR' });
    const result = resolveFieldDisplay({ kind }, spoofedCtx);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.text.includes('SHOULD NEVER APPEAR'), false);
  });
}

// --- resolveFieldDisplay: tolerates missing/malformed field ----------------

test('resolveFieldDisplay tolerates a null/undefined field without throwing', () => {
  assert.doesNotThrow(() => resolveFieldDisplay(null));
  assert.doesNotThrow(() => resolveFieldDisplay(undefined));
  assert.equal(resolveFieldDisplay(null).status, 'unavailable');
  assert.equal(resolveFieldDisplay(undefined).status, 'unavailable');
});

test('resolveFieldDisplay tolerates an unrecognized kind without throwing', () => {
  const result = resolveFieldDisplay({ kind: 'somethingNew' }, { date: 'x' });
  assert.equal(result.status, 'unavailable');
  assert.ok(result.text.length > 0);
});

// --- buildPreviewModel: null/undefined tolerance at every level ------------

test('buildPreviewModel tolerates a completely missing composition without throwing', () => {
  assert.doesNotThrow(() => buildPreviewModel(undefined));
  assert.doesNotThrow(() => buildPreviewModel(null));
  const model = buildPreviewModel(undefined);
  assert.deepEqual(model.header, {
    left: { separator: ' ', fields: [] },
    center: { separator: ' ', fields: [] },
    right: { separator: ' ', fields: [] },
    ruleLine: null,
  });
  assert.deepEqual(model.footer, model.header);
  assert.equal(model.pageNumbering, null);
  assert.deepEqual(model.warnings, { count: 0, warnings: [] });
});

test('buildPreviewModel tolerates an empty composition object', () => {
  assert.doesNotThrow(() => buildPreviewModel({}));
});

test('buildPreviewModel tolerates a variant with a missing header AND footer region', () => {
  const model = buildPreviewModel({ variants: { default: {} } });
  assert.deepEqual(model.header.center.fields, []);
  assert.deepEqual(model.footer.center.fields, []);
});

test('buildPreviewModel tolerates a region with a missing/null cell', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'sectionTitle' }] }, left: null },
  });
  const model = buildPreviewModel(config);
  assert.deepEqual(model.header.left, { separator: ' ', fields: [] });
  assert.equal(model.header.center.fields.length, 1);
});

test('buildPreviewModel tolerates a cell with non-array content', () => {
  const config = deepFreeze({ header: { center: { content: 'not-an-array' } } });
  const model = buildPreviewModel(config);
  assert.deepEqual(model.header.center.fields, []);
});

// --- buildPreviewModel: variant precedence delegates to selectVariant ------

test('buildPreviewModel: default variantKey resolves v1 top-level header/footer (no variants block)', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'literal', text: 'V1 header' }] } },
    footer: { right: { content: [{ kind: 'pageNumber' }] } },
  });
  const model = buildPreviewModel(config, 'default');
  assert.deepEqual(model.header.center.fields, [{ status: 'resolved', text: 'V1 header' }]);
  assert.equal(model.footer.right.fields[0].status, 'generation-only');
});

test('buildPreviewModel: KNOWN AMBIGUITY — default variantKey lets variants.default win over legacy top-level fields (delegates to selectVariant, no duplicate logic)', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'literal', text: 'V1' }] } },
    variants: {
      default: { header: { center: { content: [{ kind: 'literal', text: 'V2' }] } } },
    },
  });
  const model = buildPreviewModel(config, 'default');
  assert.deepEqual(model.header.center.fields, [{ status: 'resolved', text: 'V2' }]);
});

test('buildPreviewModel: an unconfigured first/even variant renders empty regions — no silent fallback to default', () => {
  const config = deepFreeze({
    variants: {
      default: { header: { center: { content: [{ kind: 'literal', text: 'DEFAULT' }] } } },
    },
  });
  const model = buildPreviewModel(config, 'first');
  assert.deepEqual(model.header.center.fields, []);
});

// --- buildPreviewModel: page numbering + rule line + separator pass-through

test('buildPreviewModel passes pageNumbering through unchanged', () => {
  const config = deepFreeze({ pageNumbering: { mode: 'restartPerSpec', startAt: 3 } });
  const model = buildPreviewModel(config);
  assert.deepEqual(model.pageNumbering, { mode: 'restartPerSpec', startAt: 3 });
});

test('buildPreviewModel passes a cell separator and region ruleLine through unchanged', () => {
  const config = deepFreeze({
    header: {
      ruleLine: { enabled: true, widthTwips: 8 },
      center: { content: [{ kind: 'sectionTitle' }], separator: ' | ' },
    },
  });
  const model = buildPreviewModel(config);
  assert.equal(model.header.center.separator, ' | ');
  assert.deepEqual(model.header.ruleLine, { enabled: true, widthTwips: 8 });
});

// --- summarizeWarnings -------------------------------------------------

test('summarizeWarnings reflects raw.warnings when present', () => {
  const config = deepFreeze({ raw: { warnings: ['unsupported w:fldSimple', 'dropped w:tab'] } });
  assert.deepEqual(summarizeWarnings(config), {
    count: 2,
    warnings: ['unsupported w:fldSimple', 'dropped w:tab'],
  });
});

test('summarizeWarnings is empty for a composition with no raw sidecar', () => {
  assert.deepEqual(summarizeWarnings({}), { count: 0, warnings: [] });
  assert.deepEqual(summarizeWarnings(undefined), { count: 0, warnings: [] });
  assert.deepEqual(summarizeWarnings(null), { count: 0, warnings: [] });
});

test('summarizeWarnings tolerates a malformed (non-array) raw.warnings without throwing', () => {
  const config = deepFreeze({ raw: { warnings: 'not-an-array' } });
  assert.deepEqual(summarizeWarnings(config), { count: 0, warnings: [] });
});
