// Pure field/variant/cell helpers for the header/footer editor (#477).
//
// Hand-kept mirror of src/ast/header-footer-schemas.ts's HeaderFooterFieldKind
// enum and defaultVariant() precedence (ADR-040) — not an import: the demo is
// plain browser ESM served statically and cannot reach src/*.ts. Keep this in
// lockstep by hand when the schema changes; the schema file's doc comments
// (defaultVariant's KNOWN AMBIGUITY note) are the source of truth.
//
// Every export here is pure: no DOM, no fetch, and never mutates an argument
// — each function returns a new object/array (house rule). Unknown/catchall
// keys at every level (ADR-021) are preserved by construction: helpers spread
// the input before overriding only the field(s) they change.

// Mirrors HeaderFooterFieldKindSchema exactly, in schema order. `freetext:
// true` marks the one kind ('literal') that needs a free-text control; every
// other kind is a reference-only picker resolved server-side from the spec's
// live context (src/generator/header-footer-fields.ts's FIELD_RESOLVERS) —
// never spec-author text.
export const FIELD_KINDS = [
  { value: 'date', label: 'Date', freetext: false },
  { value: 'sectionTitle', label: 'Section title', freetext: false },
  { value: 'sectionNumber', label: 'Section number', freetext: false },
  { value: 'pageNumber', label: 'Page number', freetext: false },
  { value: 'packageName', label: 'Package name', freetext: false },
  { value: 'revisionName', label: 'Revision name', freetext: false },
  { value: 'revisionLabel', label: 'Revision label', freetext: false },
  { value: 'projectName', label: 'Project name', freetext: false },
  { value: 'projectNumber', label: 'Project number', freetext: false },
  { value: 'clientName', label: 'Client name', freetext: false },
  { value: 'clientNumber', label: 'Client number', freetext: false },
  { value: 'literal', label: 'Literal text', freetext: true },
];

const FREETEXT_KINDS = new Set(FIELD_KINDS.filter((k) => k.freetext).map((k) => k.value));

export function isFreetext(kind) {
  return FREETEXT_KINDS.has(kind);
}

/** A freshly-seeded field for `kind` — a `text` control only for 'literal'. */
export function emptyField(kind) {
  return isFreetext(kind) ? { kind, text: '' } : { kind };
}

/**
 * The effective `default` page variant for a composition (ADR-040 port of
 * src/ast/header-footer-schemas.ts's defaultVariant). A v1 payload carries
 * its single header/footer/style at the top level, and that IS the default
 * variant. A v2 payload may instead carry `variants.default`. When both are
 * present the explicit `variants.default` wins.
 *
 * KNOWN AMBIGUITY: OOXML has no canonical answer for which layer wins when a
 * composition carries both; ADR-040 defines `variants.default` as
 * authoritative so a v2 caller can deliberately override an inherited v1
 * layer. See src/ast/header-footer-schemas.test.ts for the schema-level
 * pin of this same rule.
 */
export function defaultVariant(config) {
  if (config?.variants?.default) return config.variants.default;
  const variant = {};
  if (config?.header !== undefined) variant.header = config.header;
  if (config?.footer !== undefined) variant.footer = config.footer;
  if (config?.style !== undefined) variant.style = config.style;
  return variant;
}

/**
 * The variant for one page type — 'default' resolves through
 * {@link defaultVariant}'s v1/v2 precedence; 'first'/'even' read straight off
 * `config.variants` with NO fallback to default when unconfigured (Word
 * itself inherits the default header/footer for that page type in that case
 * — see src/generator/header-footer.ts's buildHeaders/buildFooters, which
 * pass `undefined` through rather than substituting the default variant).
 */
export function selectVariant(config, variantKey) {
  if (variantKey === 'default') return defaultVariant(config);
  return config?.variants?.[variantKey];
}

// Shallow-copies `obj`, omitting `keys`. The house style for "new object
// minus a few fields" without mutating or `delete`-ing on the input.
function omit(obj, keys) {
  const result = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (!keys.includes(key)) result[key] = value;
  }
  return result;
}

/**
 * A new composition with `variants[variantKey]` set to `variant`. Writing the
 * 'default' variant also strips the legacy top-level `header`/`footer`/
 * `style` fields from the result — once an editor writes an explicit
 * `variants.default`, leaving the v1 fields in place would recreate the
 * `defaultVariant` KNOWN AMBIGUITY on the very next read (both would be
 * present, and `variants.default` would silently win over stale v1 content
 * the editor no longer shows). Writing 'first'/'even' leaves any v1 fields
 * untouched — they are the default variant's content, unrelated to a
 * first/even override.
 */
export function withVariant(config, variantKey, variant) {
  const base = config ?? {};
  const variants = { ...(base.variants ?? {}), [variantKey]: variant };
  const stripLegacy = variantKey === 'default';
  const rest = omit(base, stripLegacy ? ['header', 'footer', 'style', 'variants'] : ['variants']);
  return { ...rest, variants };
}

/** A new composition with `pageNumbering` replaced. */
export function withPageNumbering(config, pageNumbering) {
  return { ...(config ?? {}), pageNumbering };
}

/** A new cell with `content[index]` replaced by `field`. */
export function withCellField(cell, index, field) {
  const base = cell ?? {};
  const content = Array.isArray(base.content) ? base.content : [];
  return { ...base, content: content.map((existing, i) => (i === index ? field : existing)) };
}

/** A new cell with `field` appended to `content`. */
export function addCellField(cell, field) {
  const base = cell ?? {};
  const content = Array.isArray(base.content) ? base.content : [];
  return { ...base, content: [...content, field] };
}

/** A new cell with `content[index]` removed. */
export function removeCellField(cell, index) {
  const base = cell ?? {};
  const content = Array.isArray(base.content) ? base.content : [];
  return { ...base, content: content.filter((_, i) => i !== index) };
}
