// Unit tests for the pure header/footer field/variant/cell helpers (#477). Run:
//   node --test examples/web_ui_demo/header-footer-fields.test.mjs
// Outside CI (examples/ is not a vitest project) — the demo's own regression net
// for the hand-kept mirror of src/ast/header-footer-schemas.ts's FieldKind enum
// and defaultVariant() precedence (ADR-040).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_KINDS,
  isFreetext,
  emptyField,
  defaultVariant,
  selectVariant,
  withVariant,
  withPageNumbering,
  withCellField,
  addCellField,
  removeCellField,
} from './js/header-footer-fields.mjs';

// Deep-freezes an object/array tree so any in-place mutation throws in strict
// mode (ESM modules are always strict) instead of silently succeeding — a
// stronger check than a before/after deepEqual comparison alone.
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

test('FIELD_KINDS mirrors HeaderFooterFieldKindSchema exactly (src/ast/header-footer-schemas.ts)', () => {
  assert.deepEqual(
    FIELD_KINDS.map((f) => f.value),
    [
      'date',
      'sectionTitle',
      'sectionNumber',
      'pageNumber',
      'packageName',
      'revisionName',
      'revisionLabel',
      'projectName',
      'projectNumber',
      'clientName',
      'clientNumber',
      'literal',
    ]
  );
});

test('isFreetext is true for exactly one FieldKind: literal', () => {
  const freetextKinds = FIELD_KINDS.filter((f) => isFreetext(f.value)).map((f) => f.value);
  assert.deepEqual(freetextKinds, ['literal']);
  for (const { value } of FIELD_KINDS) {
    assert.equal(isFreetext(value), value === 'literal', `isFreetext('${value}')`);
  }
});

test('emptyField seeds a text control only for the freetext kind', () => {
  assert.deepEqual(emptyField('literal'), { kind: 'literal', text: '' });
  assert.deepEqual(emptyField('sectionNumber'), { kind: 'sectionNumber' });
  assert.deepEqual(emptyField('pageNumber'), { kind: 'pageNumber' });
});

test('defaultVariant: v1-only — top-level header/footer/style IS the default variant', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'sectionTitle' }] } },
    footer: { right: { content: [{ kind: 'pageNumber' }] } },
    style: { bold: true },
  });
  assert.deepEqual(defaultVariant(config), {
    header: config.header,
    footer: config.footer,
    style: config.style,
  });
});

test('defaultVariant: v2-only — variants.default is used when no top-level fields exist', () => {
  const config = deepFreeze({
    variants: { default: { header: { center: { content: [{ kind: 'sectionTitle' }] } } } },
  });
  assert.deepEqual(defaultVariant(config), config.variants.default);
});

test('defaultVariant: KNOWN AMBIGUITY — variants.default wins over legacy top-level fields when both present', () => {
  // Mirrors src/ast/header-footer-schemas.test.ts's identically-named case:
  // ADR-040 defines the explicit variants.default as authoritative so a v2
  // caller can deliberately override an inherited v1 layer.
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'literal', text: 'V1' }] } },
    variants: {
      default: { header: { center: { content: [{ kind: 'literal', text: 'V2' }] } } },
    },
  });
  assert.deepEqual(defaultVariant(config), {
    header: { center: { content: [{ kind: 'literal', text: 'V2' }] } },
  });
});

test('defaultVariant tolerates a missing/empty composition without throwing', () => {
  assert.deepEqual(defaultVariant(undefined), {});
  assert.deepEqual(defaultVariant(null), {});
  assert.deepEqual(defaultVariant({}), {});
});

test('selectVariant: default applies the same v1/v2 precedence as defaultVariant', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'literal', text: 'V1' }] } },
    variants: {
      default: { header: { center: { content: [{ kind: 'literal', text: 'V2' }] } } },
      first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
    },
  });
  assert.deepEqual(selectVariant(config, 'default'), defaultVariant(config));
  assert.deepEqual(selectVariant(config, 'first'), config.variants.first);
  // No fallback to default: an unconfigured first/even variant reads as
  // undefined (Word inherits the default header/footer for that page type;
  // see src/generator/header-footer.ts's buildHeaders/buildFooters).
  assert.equal(selectVariant(config, 'even'), undefined);
});

test('withVariant strips legacy top-level header/footer/style once variants.default is written', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'sectionTitle' }] } },
    footer: { right: { content: [{ kind: 'pageNumber' }] } },
    style: { bold: true },
    vendorExtension: { layoutPreset: 'acme' },
  });
  const nextDefault = { header: { center: { content: [{ kind: 'literal', text: 'NEW' }] } } };
  const next = withVariant(config, 'default', nextDefault);
  assert.equal('header' in next, false);
  assert.equal('footer' in next, false);
  assert.equal('style' in next, false);
  assert.deepEqual(next.variants.default, nextDefault);
  // Non-colliding catchall keys still round-trip (ADR-021).
  assert.deepEqual(next.vendorExtension, { layoutPreset: 'acme' });
  // Input untouched.
  assert.deepEqual(config.header, { center: { content: [{ kind: 'sectionTitle' }] } });
});

test('withVariant preserves legacy top-level header/footer/style when writing a non-default variant', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'sectionTitle' }] } },
    style: { bold: true },
  });
  const firstVariant = { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } };
  const next = withVariant(config, 'first', firstVariant);
  assert.deepEqual(next.header, config.header);
  assert.deepEqual(next.style, config.style);
  assert.deepEqual(next.variants.first, firstVariant);
});

test('withVariant round-trips unrecognized catchall keys at every level and never mutates its input', () => {
  const config = deepFreeze({
    variants: {
      default: { header: { center: { content: [{ kind: 'sectionTitle' }] } } },
      even: { footer: { left: { content: [{ kind: 'pageNumber' }] } } },
    },
    raw: { warnings: ['unsupported w:fldSimple'] },
    someClientKey: { nested: { flag: true } },
  });
  const before = JSON.parse(JSON.stringify(config));
  const next = withVariant(config, 'first', {
    header: { center: { content: [{ kind: 'date' }] } },
  });
  assert.deepEqual(config, before, 'input config must be unchanged');
  assert.deepEqual(next.raw, { warnings: ['unsupported w:fldSimple'] });
  assert.deepEqual(next.someClientKey, { nested: { flag: true } });
  // The pre-existing even variant survives untouched alongside the new first.
  assert.deepEqual(next.variants.even, config.variants.even);
  assert.deepEqual(next.variants.default, config.variants.default);
});

test('withPageNumbering replaces pageNumbering without mutating or dropping other fields', () => {
  const config = deepFreeze({
    header: { center: { content: [{ kind: 'sectionTitle' }] } },
    pageNumbering: { mode: 'continuous' },
  });
  const next = withPageNumbering(config, { mode: 'restartPerSpec', startAt: 3 });
  assert.deepEqual(next.pageNumbering, { mode: 'restartPerSpec', startAt: 3 });
  assert.deepEqual(next.header, config.header);
  assert.deepEqual(config.pageNumbering, { mode: 'continuous' }, 'input config must be unchanged');
});

test('withCellField replaces one field by index, never mutating the input cell', () => {
  const cell = deepFreeze({
    content: [{ kind: 'sectionTitle' }, { kind: 'literal', text: 'old', fallback: 'name' }],
    separator: ' | ',
    style: { bold: true },
  });
  const next = withCellField(cell, 1, { kind: 'literal', text: 'new' });
  assert.deepEqual(next.content, [{ kind: 'sectionTitle' }, { kind: 'literal', text: 'new' }]);
  // Untouched sibling fields and cell-level catchall/style keys round-trip.
  assert.deepEqual(next.separator, ' | ');
  assert.deepEqual(next.style, { bold: true });
  assert.deepEqual(
    cell.content[1],
    { kind: 'literal', text: 'old', fallback: 'name' },
    'input cell must be unchanged'
  );
});

test('addCellField appends a field without mutating the input cell', () => {
  const cell = deepFreeze({ content: [{ kind: 'sectionTitle' }] });
  const next = addCellField(cell, emptyField('pageNumber'));
  assert.deepEqual(next.content, [{ kind: 'sectionTitle' }, { kind: 'pageNumber' }]);
  assert.deepEqual(cell.content, [{ kind: 'sectionTitle' }], 'input cell must be unchanged');
});

test('addCellField tolerates an undefined/empty cell (Add on a never-populated region)', () => {
  const next = addCellField(undefined, emptyField('date'));
  assert.deepEqual(next.content, [{ kind: 'date' }]);
});

test('removeCellField drops one field by index, never mutating the input cell', () => {
  const cell = deepFreeze({
    content: [{ kind: 'sectionTitle' }, { kind: 'pageNumber' }, { kind: 'literal', text: 'x' }],
  });
  const next = removeCellField(cell, 1);
  assert.deepEqual(next.content, [{ kind: 'sectionTitle' }, { kind: 'literal', text: 'x' }]);
  assert.equal(cell.content.length, 3, 'input cell must be unchanged');
});
