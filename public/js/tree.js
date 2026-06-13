// Renders one parsed spec as a vellum "sheet": CSI-labelled hierarchy tree
// plus a cross-reference footer. All text goes through textContent — spec
// content is untrusted input and must never reach innerHTML.

import { getLabel } from './labels.js';

// Matches CSI section numbers, including UFGS dotted variants (09 67 23.13).
// Whitespace-tolerant: Word text routinely separates the digit groups with
// non-breaking spaces or doubled spaces (\s covers   in JS). The server
// extractor normalizes those at ingest, so the stored targetSection has single
// spaces — matched text must be normalized the same way before lookups.
const SECTION_PATTERN = /\b\d{2}\s{1,3}\d{2}\s{1,3}\d{2}(?:\.\d{2})?\b/g;

function normalizeSection(text) {
  return text.replace(/\s+/g, ' ');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
    // display the original text verbatim; navigate/walk by normalized section
    const link = el('button', 'ref-link', match[0]);
    link.type = 'button';
    link.dataset.section = section;
    if (status === 'loaded') {
      link.title = `Jump to Section ${section}`;
      link.addEventListener('click', () => ctx.onNavigate(section));
    } else if (status === 'library') {
      link.classList.add('is-library');
      link.title = `Section ${section} is in the SpecR library but not loaded here`;
      link.addEventListener('click', () => ctx.onLibraryRef(section));
    } else {
      link.classList.add('is-unresolved');
      link.title = `Section ${section} — unresolved (not in library)`;
    }
    if (ctx.brokenSections && ctx.brokenSections.has(section)) {
      link.classList.add('is-broken');
      link.title = `Section ${section} — broken reference (target removed from project)`;
    }
    frag.appendChild(link);
    last = match.index + match[0].length;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function renderNote(node, ctx) {
  const wrap = el('div', 'tree-note');
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

// How many times each normalized section number appears in a block of text.
function sectionCounts(text) {
  const counts = new Map();
  for (const match of text.matchAll(SECTION_PATTERN)) {
    const section = normalizeSection(match[0]);
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return counts;
}

// References this edit removed. Compares per-section OCCURRENCE counts (not mere
// presence) so deleting ONE of two identical citations in a paragraph is still
// detected — set membership can't express that delta. Only references whose
// number actually appeared in the original body can be judged from text alone.
function removedReferences(originalText, newText, paraRefs) {
  const before = sectionCounts(originalText);
  const after = sectionCounts(newText);
  const bySection = new Map();
  for (const ref of paraRefs) {
    if (!ref.targetSection) continue;
    bySection.set(ref.targetSection, [...(bySection.get(ref.targetSection) ?? []), ref]);
  }
  const removed = [];
  for (const [section, refs] of bySection) {
    const delta = (before.get(section) ?? 0) - (after.get(section) ?? 0);
    if (delta > 0) removed.push(...refs.slice(0, delta));
  }
  return removed;
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function makeParaActions(node, row, ctx) {
  const actions = el('div', 'para-actions');
  const edit = el('button', 'para-act para-edit', '✎');
  edit.type = 'button';
  edit.title = 'Edit this paragraph';
  edit.addEventListener('click', () => beginEdit(node, row, ctx));
  const del = el('button', 'para-act para-del', '✕');
  del.type = 'button';
  del.title = 'Delete this paragraph (and any reference it contains)';
  del.addEventListener('click', () => ctx.onDeleteParagraph(ctx.spec, node));
  actions.appendChild(edit);
  actions.appendChild(del);
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
  ownText.appendChild(linkifyText(node.text, ctx));
  body.appendChild(ownText);
  if (node.meta && node.meta.vanish) {
    body.appendChild(el('span', 'vanish-tag', 'VANISH'));
  }
  appendNumberedChildren(body, node.children, (child, ordinal) =>
    renderPrNode(child, ordinal, ctx)
  );
  row.appendChild(body);
  if (ctx.editEnabled) row.appendChild(makeParaActions(node, row, ctx));
  return row;
}

function makeCollapsible(container, barClass, labelText, titleText, startClosed) {
  const bar = el('button', barClass);
  bar.type = 'button';
  bar.appendChild(el('span', 'twist', '▼'));
  bar.appendChild(el('span', 'node-label', labelText));
  bar.appendChild(el('span', null, titleText));
  bar.addEventListener('click', () => container.classList.toggle('is-closed'));
  if (startClosed) container.classList.add('is-closed');
  return bar;
}

function renderArticle(node, index, partNumber, ctx) {
  const wrap = el('div', 'tree-article');
  const label = getLabel('article', index, partNumber);
  wrap.appendChild(makeCollapsible(wrap, 'article-bar', label, node.text, true));
  const children = el('div', 'article-children');
  appendNumberedChildren(children, node.children, (child, ordinal) =>
    renderPrNode(child, ordinal, ctx)
  );
  wrap.appendChild(children);
  return wrap;
}

function renderPart(node, index, ctx) {
  const wrap = el('div', 'tree-part');
  wrap.appendChild(makeCollapsible(wrap, 'part-bar', getLabel('part', index), node.text, false));
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
  walk.title = `Walk to each citation of Section ${section} in this spec`;
  walk.appendChild(el('span', 'dot'));
  walk.appendChild(document.createTextNode(section));
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
      jump.title = `Jump to Section ${section}`;
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
    flag.title = `Section ${section} — the server marked this citation broken (target removed from the project)`;
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
// paragraph→references index, the broken-section set, and an edit flag. Edit
// affordances appear only when the host wired an onDeleteParagraph callback.
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
  return {
    ...ctx,
    spec,
    editEnabled: typeof ctx.onDeleteParagraph === 'function',
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
  head.appendChild(el('span', 'sheet-section', tree.section || '—'));
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
