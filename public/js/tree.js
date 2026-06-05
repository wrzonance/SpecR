// Renders one parsed spec as a vellum "sheet": CSI-labelled hierarchy tree
// plus a cross-reference footer. All text goes through textContent — spec
// content is untrusted input and must never reach innerHTML.

import { getLabel } from './labels.js';

// Matches CSI section numbers, including UFGS dotted variants (09 67 23.13).
const SECTION_PATTERN = /\b\d{2} \d{2} \d{2}(?:\.\d{2})?\b/g;

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
    const section = match[0];
    const status = ctx.statusFor(section);
    if (!status) continue;
    frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    const link = el('button', 'ref-link', section);
    link.type = 'button';
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
    frag.appendChild(link);
    last = match.index + section.length;
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

function renderPrNode(node, index, ctx) {
  if (node.type === 'note') return renderNote(node, ctx);

  const row = el('div', 'tree-node');
  if (node.meta && node.meta.vanish) row.classList.add('is-vanish');
  if (node.type === 'continuation') {
    row.classList.add('tree-continuation');
    row.appendChild(el('span', 'node-label', ''));
  } else {
    row.appendChild(el('span', 'node-label', getLabel(node.type, index)));
  }

  const body = el('div', 'node-text');
  body.appendChild(linkifyText(node.text, ctx));
  if (node.meta && node.meta.vanish) {
    body.appendChild(el('span', 'vanish-tag', 'VANISH'));
  }
  for (let i = 0; i < node.children.length; i += 1) {
    body.appendChild(renderPrNode(node.children[i], i, ctx));
  }
  row.appendChild(body);
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
  for (let i = 0; i < node.children.length; i += 1) {
    children.appendChild(renderPrNode(node.children[i], i, ctx));
  }
  wrap.appendChild(children);
  return wrap;
}

function renderPart(node, index, ctx) {
  const wrap = el('div', 'tree-part');
  wrap.appendChild(makeCollapsible(wrap, 'part-bar', getLabel('part', index), node.text, false));
  const children = el('div', 'part-children');
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];
    if (child.type === 'article') {
      children.appendChild(renderArticle(child, i, index + 1, ctx));
    } else {
      children.appendChild(renderPrNode(child, i, ctx));
    }
  }
  wrap.appendChild(children);
  return wrap;
}

function countNodes(nodes) {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children);
  return total;
}

function renderRefsFooter(references, ownSection, ctx) {
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
    footer.appendChild(el('p', 'refs-caption', 'CITES SECTIONS'));
    const row = el('div', 'ref-chip-row');
    for (const [section, count] of [...sectionRefs.entries()].sort()) {
      const status = ctx.statusFor(section) || 'unresolved';
      const chip = el('button', `ref-chip is-${status}`);
      chip.type = 'button';
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(document.createTextNode(count > 1 ? `${section} ×${count}` : section));
      if (status === 'loaded') {
        chip.title = `Jump to Section ${section}`;
        chip.addEventListener('click', () => ctx.onNavigate(section));
      } else if (status === 'library') {
        chip.title = `In SpecR library — drop the file to load it here`;
        chip.addEventListener('click', () => ctx.onLibraryRef(section));
      } else {
        chip.title = 'Unresolved — target section not in library';
      }
      row.appendChild(chip);
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

// spec: { tree, references, warnings?, capabilities? }
export function renderSpecSheet(spec, ctx) {
  const { tree, references } = spec;
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
  head.appendChild(stats);
  sheet.appendChild(head);

  const body = el('div', 'sheet-body');
  for (let i = 0; i < tree.parts.length; i += 1) {
    body.appendChild(renderPart(tree.parts[i], i, ctx));
  }
  sheet.appendChild(body);

  sheet.appendChild(renderRefsFooter(references, tree.section, ctx));
  return sheet;
}
