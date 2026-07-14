// Normalizes a UUID text-input's raw value for the demo's package/revision
// header/footer scope inputs (#481) — trims and coerces an empty string to
// null (never a bare ''), mirroring header-footer.js's getSelectedLibraryTier
// `?? null` contract. Pure, no DOM: extracted out of app.js (which reads
// `document` at module scope and so cannot be imported by a plain Node test)
// so this specific piece of logic gets a real runtime test instead of a
// source-text regex against app.js's function body.

/** @param {string} value @returns {string | null} */
export function normalizeUuidInput(value) {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
