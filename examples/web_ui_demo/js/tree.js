// Renders one parsed spec as a vellum "sheet": CSI-labelled hierarchy tree
// plus a cross-reference footer. All text goes through textContent — spec
// content is untrusted input and must never reach innerHTML.
//
// The citation matcher/normalizer lives in refs-text.js (shared with the
// WYSIWYG inline editor); the inline-editing segment machinery is
// inline-edit.js, activated per-sheet via ctx.inlineEditing (the Editor view).

import { getLabel } from './labels.js';
import { SECTION_PATTERN, normalizeSection, removedReferences } from './refs-text.js';
import {
  makeRefLink,
  renderInlineText,
  isInlineEditable,
  editabilityChip,
} from './inline-edit.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionLabel(section, ctx) {
  return typeof ctx.displaySection === 'function' ? ctx.displaySection(section) : section;
}

// Splits node text and turns known section numbers into clickable links.
// ctx.statusFor(section) -> 'loaded' | 'library' | 'unresolved' | null
// (null = not a known reference; leave as plain text).
function linkifyText(text, ctx) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(SECTION_PATTERN)) {
    const section = normalizeSection(match[0]);
    const status = ctx.statusFor(section);
    if (!status) continue;
    frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    // display the project format; navigate/walk by normalized section
    frag.appendChild(makeRefLink(section, ctx));
    last = match.index + match[0].length;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function renderNote(node, ctx) {
  const wrap = el('div', 'tree-note');
  // Notes carry a stable paragraph id too — a citation inside a NOTE can be a
  // coordination finding's sourceParagraphId, so the audit view must be able to
  // locate it (ADR-041).
  wrap.dataset.nodeId = node.id;
  wrap.appendChild(el('span', 'note-tag', 'NOTE'));
  wrap.appendChild(linkifyText(node.text, ctx));
  return wrap;
}

// Notes render as NOTE blocks, continuations with an empty label, vanish nodes
// as hidden content — none carry a CSI number, so none may consume an ordinal.
// Counting them shifted numbered siblings (#122): specifier-note banners pushed
// a 1..15 list to 5..20. Mirrors generator/markdown.ts consumesNumber.
function consumesNumber(node) {
  return node.type !== 'note' && node.type !== 'continuation' && !(node.meta && node.meta.vanish);
}

// Append each child, advancing the CSI ordinal only past numbered siblings so
// notes/continuations/vanish nodes interleave without disturbing the sequence.
function appendNumberedChildren(container, children, render) {
  let ordinal = 0;
  for (const child of children) {
    container.appendChild(render(child, ordinal));
    if (consumesNumber(child)) ordinal += 1;
  }
}

// ── Inline edit + delete affordances (mockup demo) ──────────────────────────

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// Only body paragraphs (pr1–pr7 / continuation) are soft-removable server-side
// (#251) — a part/article/note is rejected 422. Notes never reach this code
// (renderNote handles them), so the check covers the remaining structural types.
const REMOVABLE_TYPES = new Set(['pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7', 'continuation']);

function makeRemovalButton(node, ctx) {
  const removed = Boolean(node.meta && node.meta.vanish);
  const btn = el(
    'button',
    `para-act para-removal${removed ? ' is-restore' : ''}`,
    removed ? '↩' : '⊘'
  );
  btn.type = 'button';
  btn.title = removed
    ? 'Restore this paragraph (clears the removal)'
    : 'Remove this paragraph (reversible — it is hidden from owner renders, not deleted)';
  btn.addEventListener('click', () => ctx.onToggleParagraphRemoval(ctx.spec, node, !removed));
  return btn;
}

function makeParaActions(node, row, ctx) {
  const actions = el('div', 'para-actions');
  // WYSIWYG sheets edit by clicking into the text — the ✎ textarea flow is
  // the fallback for the board views only.
  if (ctx.editEnabled && !ctx.inlineEditing) {
    const edit = el('button', 'para-act para-edit', '✎');
    edit.type = 'button';
    edit.title = 'Edit this paragraph';
    edit.addEventListener('click', () => beginEdit(node, row, ctx));
    actions.appendChild(edit);
  }
  // Gate on the SERVER-truth type (baseType survives the editor's local
  // restructure preview) — the removal PATCH 422s on a real heading, and a
  // preview-demoted article is still a heading in the database.
  if (ctx.removalEnabled && REMOVABLE_TYPES.has(node.baseType ?? node.type)) {
    actions.appendChild(makeRemovalButton(node, ctx));
  }
  if (ctx.deleteEnabled) {
    const del = el('button', 'para-act para-del', '✕');
    del.type = 'button';
    del.title = 'Delete this paragraph (and any reference it contains)';
    del.addEventListener('click', () => ctx.onDeleteParagraph(ctx.spec, node));
    actions.appendChild(del);
  }
  return actions;
}

function beginEdit(node, row, ctx) {
  if (row.classList.contains('is-editing')) return;
  const ownText = row.querySelector(':scope > .node-text > .node-own-text');
  if (!ownText) return;
  row.classList.add('is-editing');

  const editor = el('div', 'para-editor');
  const input = el('textarea', 'para-input');
  input.value = node.text;
  const bar = el('div', 'para-editbar');
  const save = el('button', 'para-save', 'Save');
  save.type = 'button';
  const cancel = el('button', 'para-cancel', 'Cancel');
  cancel.type = 'button';
  bar.appendChild(save);
  bar.appendChild(cancel);
  editor.appendChild(input);
  editor.appendChild(bar);
  ownText.replaceWith(editor);
  autosize(input);
  input.focus();
  input.addEventListener('input', () => autosize(input));

  cancel.addEventListener('click', () => {
    const fresh = el('span', 'node-own-text');
    fresh.appendChild(linkifyText(node.text, ctx));
    editor.replaceWith(fresh);
    row.classList.remove('is-editing');
  });
  save.addEventListener('click', () => void commitEdit({ node, ctx, input, save, cancel }));
}

async function commitEdit({ node, ctx, input, save, cancel }) {
  const newText = input.value.trim();
  if (newText.length === 0) {
    if (ctx.toast) ctx.toast('A paragraph cannot be empty — delete it instead', 'warn');
    return;
  }
  if (newText === node.text) {
    cancel.click(); // no change — just leave the editor
    return;
  }
  const removed = removedReferences(node.text, newText, ctx.referencesFor(node.id));
  save.disabled = true;
  cancel.disabled = true;
  // 'committed' → the board re-renders and discards this editor; otherwise the
  // user backed out of the warning, so re-enable and stay in edit mode.
  const outcome = await ctx.onSaveParagraphEdit({
    spec: ctx.spec,
    node,
    newText,
    removedRefs: removed,
  });
  if (outcome !== 'committed') {
    save.disabled = false;
    cancel.disabled = false;
  }
}

function renderPrNode(node, index, ctx) {
  if (node.type === 'note') return renderNote(node, ctx);

  const row = el('div', 'tree-node');
  row.dataset.nodeId = node.id;
  if (node.meta && node.meta.vanish) row.classList.add('is-vanish');
  if (node.type === 'continuation') {
    row.classList.add('tree-continuation');
    row.appendChild(el('span', 'node-label', ''));
  } else {
    row.appendChild(el('span', 'node-label', getLabel(node.type, index)));
  }

  const body = el('div', 'node-text');
  const ownText = el('span', 'node-own-text');
  if (isInlineEditable(node, ctx)) {
    renderInlineText(node, ownText, ctx);
  } else {
    ownText.appendChild(linkifyText(node.text, ctx));
  }
  body.appendChild(ownText);
  if (node.meta && node.meta.vanish) {
    body.appendChild(el('span', 'vanish-tag', 'VANISH'));
  }
  appendNumberedChildren(body, node.children, (child, ordinal) =>
    renderPrNode(child, ordinal, ctx)
  );
  row.appendChild(body);
  if (ctx.inlineEditing) {
    const chip = editabilityChip(node);
    if (chip) row.appendChild(chip);
  }
  if (ctx.actionsEnabled) row.appendChild(makeParaActions(node, row, ctx));
  return row;
}

// Part/article heading bar. Read views render one collapse button; the
// WYSIWYG editor splits it — twist+label still toggles, but the heading text
// becomes an inline-editable segment and an article gains a ⇥ demote action
// (same operation as Tab inside it).
function makeCollapsible(container, barClass, labelText, node, ctx, startClosed) {
  if (startClosed) container.classList.add('is-closed');
  if (!ctx.inlineEditing) {
    const bar = el('button', barClass);
    bar.type = 'button';
    bar.appendChild(el('span', 'twist', '▼'));
    bar.appendChild(el('span', 'node-label', labelText));
    bar.appendChild(el('span', null, node.text));
    bar.addEventListener('click', () => container.classList.toggle('is-closed'));
    return bar;
  }
  const bar = el('div', `${barClass} is-wys`);
  bar.dataset.nodeId = node.id;
  const toggle = el('button', 'bar-toggle');
  toggle.type = 'button';
  toggle.title = 'Collapse / expand';
  toggle.appendChild(el('span', 'twist', '▼'));
  toggle.appendChild(el('span', 'node-label', labelText));
  toggle.addEventListener('click', () => container.classList.toggle('is-closed'));
  bar.appendChild(toggle);
  const ownText = el('span', 'node-own-text');
  if (isInlineEditable(node, ctx)) renderInlineText(node, ownText, ctx);
  else ownText.appendChild(linkifyText(node.text, ctx));
  bar.appendChild(ownText);
  if (node.type === 'article' && typeof ctx.onRestructure === 'function') {
    const demote = el('button', 'bar-demote', '⇥');
    demote.type = 'button';
    demote.title = 'Demote this article to a paragraph under the previous article (Tab inside it)';
    demote.addEventListener('click', () => ctx.onRestructure(node, 1, null));
    bar.appendChild(demote);
  }
  // A body paragraph promoted to an article in the restructure preview is
  // still removable server-side — keep its ⊘ reachable on the heading bar.
  if (ctx.removalEnabled && REMOVABLE_TYPES.has(node.baseType ?? node.type)) {
    bar.appendChild(makeRemovalButton(node, ctx));
  }
  return bar;
}

// Humanizes an ADR-033 article role enum ('related-sections' → 'Related Sections')
// for the heading chip. The server only emits the recognized kebab-case values,
// so a generic de-kebab keeps the demo correct if the enum grows server-side.
function humanizeArticleRole(role) {
  return role
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// The role chip surfaces meta.articleRole (present only on recognized article
// nodes — GET /specs/:id, ADR-033). Absent for unknown/non-standard articles.
function articleRoleChip(node) {
  const role = node.meta && node.meta.articleRole;
  if (!role) return null;
  const chip = el('span', `article-role role-${role}`, humanizeArticleRole(role));
  chip.title = `CSI article role: ${humanizeArticleRole(role)} (inferred from heading)`;
  return chip;
}

function renderArticle(node, index, partNumber, ctx) {
  const wrap = el('div', 'tree-article');
  const label = getLabel('article', index, partNumber);
  const bar = makeCollapsible(wrap, 'article-bar', label, node, ctx, true);
  const chip = articleRoleChip(node);
  if (chip) bar.appendChild(chip);
  wrap.appendChild(bar);
  const children = el('div', 'article-children');
  appendNumberedChildren(children, node.children, (child, ordinal) =>
    renderPrNode(child, ordinal, ctx)
  );
  wrap.appendChild(children);
  return wrap;
}

function renderPart(node, index, ctx) {
  const wrap = el('div', 'tree-part');
  wrap.appendChild(makeCollapsible(wrap, 'part-bar', getLabel('part', index), node, ctx, false));
  const children = el('div', 'part-children');
  appendNumberedChildren(children, node.children, (child, ordinal) =>
    child.type === 'article'
      ? renderArticle(child, ordinal, index + 1, ctx)
      : renderPrNode(child, ordinal, ctx)
  );
  wrap.appendChild(children);
  return wrap;
}

function countNodes(nodes) {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children);
  return total;
}

// Opens every collapsed part/article between a node and the sheet root so a
// citation hidden inside a collapsed article becomes visible before scrolling.
export function expandAncestors(node) {
  let current = node.parentElement;
  while (current) {
    if (
      current.classList.contains('is-closed') &&
      (current.classList.contains('tree-article') || current.classList.contains('tree-part'))
    ) {
      current.classList.remove('is-closed');
    }
    current = current.parentElement;
  }
}

let currentLocated = null;

function pulseOnArrival(link) {
  // Smooth scrollIntoView can take seconds on long sheets; an animation
  // started at click time finishes while the target is still off-screen.
  // Defer the pulse until the link actually enters the viewport.
  const observer = new IntersectionObserver(
    (entries, obs) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      link.classList.remove('is-located');
      void link.offsetWidth; // restart the locate animation
      link.classList.add('is-located');
      link.addEventListener('animationend', () => link.classList.remove('is-located'), {
        once: true,
      });
    },
    { threshold: 0.9 }
  );
  observer.observe(link);
  setTimeout(() => observer.disconnect(), 10000); // hygiene: never observe forever
}

// Expands, scrolls to, marks, and locate-pulses an in-body citation link.
// The is-current marker is persistent (until the next walk step) so the
// found citation stays identifiable even after the pulse fades.
export function locateLink(link) {
  expandAncestors(link);
  if (currentLocated && currentLocated !== link) {
    currentLocated.classList.remove('is-current', 'is-located');
  }
  currentLocated = link;
  link.classList.add('is-current');
  link.scrollIntoView({ behavior: 'smooth', block: 'center' });
  pulseOnArrival(link);
}

// Steps through the in-body citation sites of `section` within this sheet,
// cycling on repeated clicks. Returns { index, total } or null when the body
// has no linkified occurrence (refs can come from text the linkifier missed).
function walkToCitation(sheet, section, walkState) {
  const links = [...sheet.querySelectorAll('.ref-link')].filter(
    (l) => l.dataset.section === section
  );
  if (links.length === 0) return null;
  const index = ((walkState.get(section) ?? -1) + 1) % links.length;
  walkState.set(section, index);
  locateLink(links[index]);
  return { index, total: links.length };
}

// Split chip: the main button walks the citation sites inside THIS spec's
// body; the ↗ tail keeps the old jump-to-referenced-sheet behavior.
function makeSectionChip(section, count, ctx, sheet, walkState) {
  const status = ctx.statusFor(section) || 'unresolved';
  const broken = Boolean(ctx.brokenSections && ctx.brokenSections.has(section));
  const chip = el('span', `ref-chip is-${status}${broken ? ' is-broken' : ''}`);

  const walk = el('button', 'ref-walk');
  walk.type = 'button';
  walk.title = `Walk to each citation of Section ${sectionLabel(section, ctx)} in this spec`;
  walk.appendChild(el('span', 'dot'));
  walk.appendChild(document.createTextNode(sectionLabel(section, ctx)));
  const pos = el('span', 'walk-pos', count > 1 ? `×${count}` : '');
  walk.appendChild(pos);
  walk.addEventListener('click', () => {
    const result = walkToCitation(sheet, section, walkState);
    if (result) {
      pos.textContent = `${result.index + 1}/${result.total}`;
      return;
    }
    // The ref row exists (chip rendered) but the body has no linkified site —
    // surface WHY instead of failing silently. Headings aren't linkified, and
    // unknown text shapes can escape the matcher; the console gets specifics.
    const bodyHasPattern = sheet.textContent.replace(/\s+/g, ' ').includes(section);
    console.warn(
      `SpecR citation walk: no in-body link for ${section} on sheet ${sheet.dataset.section}.`,
      bodyHasPattern
        ? 'The section number DOES appear in the sheet text — likely inside a heading bar or a text shape the linkifier missed. Please report this with the surrounding text.'
        : 'The section number does not appear in the body text at all — the reference was extracted from text that does not contain the number verbatim.'
    );
    if (ctx.onWalkMiss) ctx.onWalkMiss(section, bodyHasPattern);
    if (status === 'loaded') ctx.onNavigate(section); // fall back to the jump
  });
  chip.appendChild(walk);

  if (status === 'loaded' || status === 'library') {
    const jump = el('button', 'ref-jump', '↗');
    jump.type = 'button';
    if (status === 'loaded') {
      jump.title = `Jump to Section ${sectionLabel(section, ctx)}`;
      jump.addEventListener('click', () => ctx.onNavigate(section));
    } else {
      jump.title = 'In SpecR library — drop the file to load it here';
      jump.addEventListener('click', () => ctx.onLibraryRef(section));
    }
    chip.appendChild(jump);
  } else {
    chip.title = 'Unresolved — target section not in library';
  }
  if (broken) {
    const flag = el('span', 'chip-broken', '⚠ BROKEN');
    flag.title = `Section ${sectionLabel(section, ctx)} — the server marked this citation broken (target removed from the project)`;
    chip.appendChild(flag);
  }
  return chip;
}

function renderRefsFooter(references, ownSection, ctx, sheet, walkState) {
  const footer = el('footer', 'sheet-refs');
  const sectionRefs = new Map(); // targetSection -> count
  const standards = new Set();

  for (const ref of references) {
    if (ref.targetSection === ownSection) continue; // self-citation is header noise
    if (ref.targetSection) {
      sectionRefs.set(ref.targetSection, (sectionRefs.get(ref.targetSection) || 0) + 1);
    } else {
      standards.add(ref.referenceText);
    }
  }

  if (sectionRefs.size === 0 && standards.size === 0) {
    footer.appendChild(el('p', 'refs-caption', 'NO OUTBOUND REFERENCES EXTRACTED'));
    return footer;
  }

  if (sectionRefs.size > 0) {
    footer.appendChild(
      el('p', 'refs-caption', 'CITES SECTIONS — CLICK TO WALK CITATIONS, ↗ TO OPEN')
    );
    const row = el('div', 'ref-chip-row');
    for (const [section, count] of [...sectionRefs.entries()].sort()) {
      row.appendChild(makeSectionChip(section, count, ctx, sheet, walkState));
    }
    footer.appendChild(row);
  }

  if (standards.size > 0) {
    const group = el('div', 'refs-group is-closed');
    const toggle = el('button', 'refs-toggle', `▸ CITES ${standards.size} STANDARDS — SHOW`);
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      const closed = group.classList.toggle('is-closed');
      toggle.textContent = closed
        ? `▸ CITES ${standards.size} STANDARDS — SHOW`
        : `▾ CITES ${standards.size} STANDARDS — HIDE`;
    });
    group.appendChild(toggle);
    const row = el('div', 'ref-chip-row');
    for (const code of [...standards].sort()) {
      row.appendChild(el('span', 'std-badge', code));
    }
    group.appendChild(row);
    footer.appendChild(group);
  }

  return footer;
}

// Derives a per-sheet render context: the base callbacks plus the spec, a
// paragraph→references index, the broken-section set, and per-affordance flags.
// Each paragraph action appears only when the host wired its callback:
//   edit    → onSaveParagraphEdit   (text editing — always on in the demo)
//   removal → onToggleParagraphRemoval (#251 soft removal, flag-gated)
//   delete  → onDeleteParagraph     (hard delete, Phase-4-gated)
// actionsEnabled gates the whole action row so nodes stay clean when nothing is
// wired.
function buildSheetCtx(spec, ctx) {
  const refsByParagraph = new Map();
  for (const ref of spec.references) {
    if (!ref.sourceParagraphId) continue;
    refsByParagraph.set(ref.sourceParagraphId, [
      ...(refsByParagraph.get(ref.sourceParagraphId) ?? []),
      ref,
    ]);
  }
  const brokenSections = new Set(
    spec.references.filter((r) => r.isBroken && r.targetSection).map((r) => r.targetSection)
  );
  const editEnabled = typeof ctx.onSaveParagraphEdit === 'function';
  const removalEnabled = typeof ctx.onToggleParagraphRemoval === 'function';
  const deleteEnabled = typeof ctx.onDeleteParagraph === 'function';
  return {
    ...ctx,
    spec,
    editEnabled,
    removalEnabled,
    deleteEnabled,
    actionsEnabled: editEnabled || removalEnabled || deleteEnabled,
    referencesFor: (nodeId) => refsByParagraph.get(nodeId) ?? [],
    brokenSections,
  };
}

// spec: { tree, references, warnings?, capabilities? }
export function renderSpecSheet(spec, ctx) {
  const { tree, references } = spec;
  const actx = buildSheetCtx(spec, ctx);
  const sheet = el('article', 'spec-sheet');
  sheet.dataset.section = tree.section;
  sheet.id = `sheet-${tree.id}`;

  const head = el('header', 'sheet-head');
  head.appendChild(
    el('span', 'sheet-section', tree.section ? sectionLabel(tree.section, actx) : '—')
  );
  head.appendChild(el('h2', 'sheet-title', tree.title || 'Untitled Section'));

  const stats = el('div', 'sheet-stats');
  stats.appendChild(el('span', 'stat-chip', `${countNodes(tree.parts)} NODES`));
  stats.appendChild(el('span', 'stat-chip', `${references.length} REFS`));
  if (spec.capabilities && spec.capabilities.includes('read-only')) {
    stats.appendChild(el('span', 'stat-chip read-only', 'READ-ONLY'));
  }
  if (spec.warnings && spec.warnings.length > 0) {
    const warn = el('span', 'stat-chip warn', `⚠ ${spec.warnings.length}`);
    warn.title = spec.warnings
      .map((w) => w.type + (w.suggestion ? ` — ${w.suggestion}` : ''))
      .join('\n');
    stats.appendChild(warn);
  }
  if (typeof actx.onAddSpecToToc === 'function') {
    const addToToc = el('button', 'sheet-toc-add', 'ADD TO TOC');
    addToToc.type = 'button';
    addToToc.title = 'Add this section to the project TOC.';
    addToToc.addEventListener('click', () => actx.onAddSpecToToc(spec));
    stats.appendChild(addToToc);
  }
  if (typeof actx.onRemoveSpecFromProject === 'function') {
    const remove = el('button', 'sheet-remove', 'DELETE');
    remove.type = 'button';
    remove.title = 'Remove this section from the project. The TOC is unchanged.';
    remove.addEventListener('click', () => actx.onRemoveSpecFromProject(spec));
    stats.appendChild(remove);
  }
  head.appendChild(stats);
  sheet.appendChild(head);

  const body = el('div', 'sheet-body');
  // tree.parts holds ROOT nodes, not necessarily part-type nodes: degraded or
  // preamble-bearing parses put notes and continuations at root too. Only
  // part-type nodes get PART numbering — labelling roots by raw array index
  // rendered ARCAT preambles as "PART 1..10" and the real parts as 11/12/13.
  let partIndex = 0;
  for (const node of tree.parts) {
    if (node.type === 'part') {
      body.appendChild(renderPart(node, partIndex, actx));
      partIndex += 1;
    } else if (node.type === 'note') {
      body.appendChild(renderNote(node, actx));
    } else if (node.text.trim().length > 0) {
      const fm = el('p', 'front-matter');
      fm.appendChild(linkifyText(node.text, actx));
      body.appendChild(fm);
    }
  }
  sheet.appendChild(body);

  // per-sheet cursor for citation walking: section -> last visited index
  const walkState = new Map();
  sheet.appendChild(renderRefsFooter(references, tree.section, actx, sheet, walkState));
  return sheet;
}
