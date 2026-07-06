// WYSIWYG inline editing for the Editor view, ported from the reference
// design: click into any text to edit in place (no textarea swap), changes
// save when you click away, citation chips stay non-editable inline with an ×
// to remove them, and Tab / Shift+Tab restructures the paragraph through the
// CSI tier ladder (js/restructure.js) with live renumbering.
//
// The paragraph body is rendered as SEGMENTS: plain-text runs are individual
// contenteditable spans; each citation is a contenteditable=false chip between
// them, carrying the verbatim matched text in data-raw. On blur the paragraph
// text is reconstructed run-by-run + chip-raw, so the chip display format
// (project section-number setting) never leaks into the stored text. All text
// still reaches the DOM via textContent — spec content is untrusted.

import { sectionMatches, removedReferences } from './refs-text.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionLabel(section, ctx) {
  return typeof ctx.displaySection === 'function' ? ctx.displaySection(section) : section;
}

// A clickable in-text citation link, shared by the read-mode linkifier
// (tree.js) and the WYSIWYG segment renderer. Displays the project's
// section-number format; navigates by the normalized section.
export function makeRefLink(section, ctx) {
  const status = ctx.statusFor(section);
  const link = el('button', 'ref-link', sectionLabel(section, ctx));
  link.type = 'button';
  link.dataset.section = section;
  if (status === 'loaded') {
    link.title = `Jump to Section ${sectionLabel(section, ctx)}`;
    link.addEventListener('click', () => ctx.onNavigate(section));
  } else if (status === 'library') {
    link.classList.add('is-library');
    link.title = `Section ${sectionLabel(section, ctx)} is in the SpecR library but not loaded here`;
    link.addEventListener('click', () => ctx.onLibraryRef(section));
  } else {
    link.classList.add('is-unresolved');
    link.title = `Section ${sectionLabel(section, ctx)} — unresolved (not in library)`;
  }
  if (ctx.brokenSections && ctx.brokenSections.has(section)) {
    link.classList.add('is-broken');
    link.title = `Section ${sectionLabel(section, ctx)} — broken reference (target removed from project)`;
  }
  return link;
}

// Is this node's text editable in place? Vanished rows restore first; a
// paragraph the editability program classified as locked stays read-only.
export function isInlineEditable(node, ctx) {
  if (!ctx.inlineEditing) return false;
  if (node.type === 'note' || node.type === 'spec') return false;
  if (node.meta && node.meta.vanish) return false;
  const editability = node.meta && node.meta.editability;
  const value = editability && (editability.override ?? editability.value);
  return value !== 'locked';
}

// Paragraph text reconstructed from the segment DOM: editable runs contribute
// their live textContent, chips contribute the verbatim text they replaced.
function reconstruct(ownText) {
  let text = '';
  for (const child of ownText.children) {
    if (child.classList.contains('wys-run')) text += child.textContent;
    else if (child.classList.contains('wys-ref')) text += child.dataset.raw;
  }
  return text;
}

async function commit(node, ownText, ctx, newTextOverride) {
  const newText = newTextOverride ?? reconstruct(ownText);
  if (newText === node.text) return;
  // Enter-inserted drafts have no server row to PATCH (#372) — their text
  // lives in the editor's structure op until an endpoint exists. Empty is
  // fine for a draft; it starts that way.
  if (node.meta && node.meta.localDraft) {
    if (typeof ctx.onLocalDraftEdit === 'function') ctx.onLocalDraftEdit(node, newText);
    return;
  }
  if (newText.trim().length === 0) {
    if (ctx.toast) ctx.toast('A paragraph cannot be empty — use ⊘ to remove it instead', 'warn');
    renderInlineText(node, ownText, ctx); // restore the last saved text
    return;
  }
  const removed = removedReferences(node.text, newText, ctx.referencesFor(node.id));
  const oldText = node.text;
  // Optimistic: the sheet re-renders from client state the moment the save
  // pipeline refreshes the board; showing the typed text immediately avoids a
  // flash of the stale paragraph while the PATCH is in flight.
  node.text = newText;
  const outcome = await ctx.onSaveParagraphEdit({ spec: ctx.spec, node, newText, removedRefs: removed });
  if (outcome === 'cancelled') {
    node.text = oldText;
    // The editor may have mirrored the pending text onto server-truth state
    // and re-rendered (Enter/Tab) before this dialog resolved — let it roll
    // that back and redraw; otherwise restore this row's text in place.
    if (typeof ctx.onEditCancelled === 'function') ctx.onEditCancelled(node, oldText);
    else renderInlineText(node, ownText, ctx);
  }
}

function makeRun(text, node, ownText, ctx) {
  const run = el('span', 'wys-run', text);
  // plaintext-only keeps pasted markup out; unsupported engines fall back to
  // rich editing and the textContent reconstruction strips formatting on save.
  run.setAttribute('contenteditable', 'plaintext-only');
  if (!run.isContentEditable) run.setAttribute('contenteditable', 'true');
  run.addEventListener('focus', () => {
    const row = ownText.closest('[data-node-id]');
    if (row) row.classList.add('is-inline-editing');
  });
  run.addEventListener('blur', () => {
    const row = ownText.closest('[data-node-id]');
    if (row) row.classList.remove('is-inline-editing');
    void commit(node, ownText, ctx);
  });
  run.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      run.blur();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (typeof ctx.onInsertAfter === 'function') {
        // Same capture-before-blur dance as Tab: blur's commit mutates
        // node.text synchronously, so decide the pending payload first.
        const newText = reconstruct(ownText);
        const pendingText = newText !== node.text && newText.trim().length > 0 ? newText : null;
        run.blur();
        ctx.onInsertAfter(node, pendingText);
      } else {
        run.blur();
      }
      return;
    }
    if (event.key === 'Tab' && typeof ctx.onRestructure === 'function') {
      event.preventDefault();
      const newText = reconstruct(ownText);
      // Decide BEFORE blur(): its listener commits synchronously up to the
      // await and sets node.text = newText, which would make this comparison
      // always false. Whitespace-only text is what commit rejects — never
      // mirror it onto the base tree.
      const pendingText = newText !== node.text && newText.trim().length > 0 ? newText : null;
      run.blur();
      ctx.onRestructure(node, event.shiftKey ? -1 : 1, pendingText);
    }
  });
  return run;
}

// Removing a citation chip goes through the same save pipeline as typing the
// number out: when a tracked outbound reference is removed, the host's
// removed-reference dialog decides whether the target section should also
// leave the project. Untracked citations (self-references, numbers the
// extractor didn't index) get a plain confirm via ctx.confirmRefRemoval so a
// stray × click can't silently rewrite the paragraph.
function makeChipRemove(node, ownText, ctx, chip, section) {
  const x = el('button', 'wys-ref-x', '×');
  x.type = 'button';
  x.title = 'Remove this cross-reference from the paragraph';
  x.addEventListener('click', async () => {
    chip.remove();
    const newText = reconstruct(ownText);
    const tracked = removedReferences(node.text, newText, ctx.referencesFor(node.id));
    if (tracked.length === 0 && typeof ctx.confirmRefRemoval === 'function') {
      const ok = await ctx.confirmRefRemoval(section);
      if (!ok) {
        renderInlineText(node, ownText, ctx);
        return;
      }
    }
    void commit(node, ownText, ctx);
  });
  return x;
}

// Renders node.text into `ownText` as editable runs + citation chips.
// Chips are only created for numbers the status resolver recognizes — the
// same gate the read-mode linkifier applies.
export function renderInlineText(node, ownText, ctx) {
  ownText.replaceChildren();
  ownText.classList.add('wys-text');
  const matches = sectionMatches(node.text).filter((m) => ctx.statusFor(m.section));
  let last = 0;
  for (const match of matches) {
    ownText.appendChild(makeRun(node.text.slice(last, match.start), node, ownText, ctx));
    const chip = el('span', 'wys-ref');
    chip.setAttribute('contenteditable', 'false');
    chip.dataset.raw = match.raw;
    chip.appendChild(makeRefLink(match.section, ctx));
    chip.appendChild(makeChipRemove(node, ownText, ctx, chip, match.section));
    ownText.appendChild(chip);
    last = match.end;
  }
  ownText.appendChild(makeRun(node.text.slice(last), node, ownText, ctx));
}

// The editability chip the reference design shows beside each paragraph while
// editing is enabled. Only rendered when ingest actually classified the node.
export function editabilityChip(node) {
  const editability = node.meta && node.meta.editability;
  if (!editability) return null;
  const value = editability.override ?? editability.value;
  if (!value) return null;
  const chip = el('span', `wys-ed-chip is-${value}`, value.toUpperCase());
  chip.title =
    value === 'locked'
      ? 'Locked by the source master — not editable in this project'
      : `Classified ${value} by the editability program`;
  return chip;
}
