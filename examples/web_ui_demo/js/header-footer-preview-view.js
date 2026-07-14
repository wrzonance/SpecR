// Header/footer preview + variant-tab DOM painting for the demo editor (#477).
//
// Pure DOM paint: no fetch, no state of its own — every render* function takes
// a container element plus already-resolved data (a `PreviewModel` from
// header-footer-preview.mjs, or a variant key) and repaints that container's
// children from scratch. Callers own re-invoking these on every local edit;
// this module never reaches back into header-footer-fields.mjs/api.js itself.
//
// SECURITY: header/footer field text is spec-author/client/project content —
// never trusted. Every piece of it is written via `textContent` (see `el`
// below), NEVER `innerHTML`/`insertAdjacentHTML`, so a literal field value
// containing HTML-looking text can never be interpreted as markup (XSS).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// One resolved cell (`{ separator, fields: [{ status, text }] }` from
// header-footer-preview.mjs's resolveCell) as a single inline span. An empty
// cell (no configured content) renders a literal em dash — not user text, so
// hardcoding it here is safe — never an empty string, which would be
// indistinguishable on screen from a resolved-but-blank field.
function renderCellSpan(position, cell) {
  const span = el('span', `hf-preview-cell hf-preview-cell-${position}`);
  const fields = cell?.fields ?? [];
  if (fields.length === 0) {
    span.appendChild(el('span', 'hf-field hf-field-empty', '—'));
    return span;
  }
  fields.forEach((field, index) => {
    if (index > 0) span.appendChild(document.createTextNode(cell?.separator ?? ' '));
    span.appendChild(el('span', `hf-field hf-field-${field.status}`, field.text));
  });
  return span;
}

// One resolved region (header or footer) — label, left/center/right row, and
// a rule-line indicator that appears ONLY when `ruleLine.enabled === true`
// (mirrors src/generator/header-footer-regions.ts's ruleLineBorder, which
// treats a missing/false/absent `enabled` identically — no rule line).
function renderRegion(parent, label, region) {
  const section = el('div', 'hf-preview-region');
  section.appendChild(el('div', 'hf-preview-region-label', label));
  const row = el('div', 'hf-preview-row');
  row.appendChild(renderCellSpan('left', region?.left));
  row.appendChild(renderCellSpan('center', region?.center));
  row.appendChild(renderCellSpan('right', region?.right));
  section.appendChild(row);
  if (region?.ruleLine?.enabled === true) section.appendChild(el('div', 'hf-preview-rule'));
  parent.appendChild(section);
}

// The page-numbering band's text, or `null` to omit the band entirely.
// `mode: 'restartPerSpec'` defaults `startAt` to 1 (matches
// src/generator/header-footer.ts's resolvePageNumberStart); `'continuous'`
// ignores `startAt` entirely, same as the generator. An absent/unrecognized
// `pageNumbering` (no mode configured anywhere in the chain) omits the band
// rather than fabricating a policy the composition doesn't actually carry.
function pageNumberingText(pageNumbering) {
  if (pageNumbering?.mode === 'restartPerSpec') {
    return `Page numbering: restarts each spec section, starting at ${pageNumbering.startAt ?? 1}`;
  }
  if (pageNumbering?.mode === 'continuous') return 'Page numbering: continuous across the package';
  return null;
}

// The captured-but-unmodeled-OOXML warnings block (`PreviewModel.warnings`
// from summarizeWarnings) — omitted entirely when there's nothing to show.
function renderWarnings(parent, warnings) {
  if (!warnings || warnings.count === 0) return;
  const block = el('div', 'hf-preview-warnings');
  const noun = warnings.count === 1 ? 'detail' : 'details';
  block.appendChild(
    el(
      'p',
      'hf-preview-warnings-head',
      `${warnings.count} unsupported OOXML ${noun} captured but not shown in this preview:`
    )
  );
  const list = el('ul', 'hf-preview-warnings-list');
  for (const warning of warnings.warnings) list.appendChild(el('li', null, warning));
  block.appendChild(list);
  parent.appendChild(block);
}

/**
 * Paints `model` (a `PreviewModel` from header-footer-preview.mjs's
 * buildPreviewModel) into `container` — header region, an optional page-
 * numbering band, footer region, then an optional warnings block. Replaces
 * `container`'s entire contents on every call (the container is a dedicated
 * preview mount the caller owns outright — unlike `#editor-inspector`, there
 * is nothing else in it to preserve). Tolerates a null/undefined/malformed
 * `model` at every level without throwing, same totality contract as the
 * model builder it renders.
 */
export function renderPreview(container, model) {
  container.replaceChildren();
  const root = el('div', 'hf-preview');
  renderRegion(root, 'Header', model?.header);
  const band = pageNumberingText(model?.pageNumbering);
  if (band) root.appendChild(el('div', 'hf-preview-page-band', band));
  renderRegion(root, 'Footer', model?.footer);
  renderWarnings(root, model?.warnings);
  container.appendChild(root);
}

// Word's three page-variant kinds (ADR-040), in the order they're offered as
// tabs. Kept local to this view — header-footer-fields.mjs's selectVariant
// takes the key as a plain string and needs no knowledge of these labels.
const VARIANT_TABS = [
  { key: 'default', label: 'Default' },
  { key: 'first', label: 'First page' },
  { key: 'even', label: 'Even pages' },
];

/**
 * Paints a `default` / `first` / `even` tab strip into `container`, marking
 * `activeKey` with `.is-active`, and calling `onSelect(key)` on click of any
 * tab (including the already-active one — the caller decides whether a
 * reselect is a no-op). Replaces `container`'s entire contents on every call.
 */
export function renderVariantTabs(container, activeKey, onSelect) {
  container.replaceChildren();
  const tabs = el('div', 'hf-variant-tabs');
  for (const { key, label } of VARIANT_TABS) {
    const tab = el('button', 'hf-variant-tab', label);
    tab.type = 'button';
    if (key === activeKey) tab.classList.add('is-active');
    tab.addEventListener('click', () => onSelect(key));
    tabs.appendChild(tab);
  }
  container.appendChild(tabs);
}
