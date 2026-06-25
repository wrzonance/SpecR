// Renders the project-scoped open-comments report (#262/#272): unresolved
// review comments across every spec in the active project. Mirrors the
// coordination renderer's vellum-on-ink style — summary chips over a grouped
// list. All comment text goes through textContent (untrusted owner/editor input).

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A clickable section badge that navigates to the spec sheet (section-level).
function sectionButton(section, ctx) {
  const btn = el(
    'button',
    'coord-section',
    ctx.displaySection ? ctx.displaySection(section) : section
  );
  btn.type = 'button';
  btn.title = `Jump to Section ${section}`;
  btn.addEventListener('click', () => ctx.onNavigate?.(section));
  return btn;
}

function renderComment(comment, ctx) {
  const row = el('li', 'oc-comment');
  const head = el('div', 'oc-comment-head');
  head.appendChild(sectionButton(comment.specSection, ctx));
  head.appendChild(el('span', 'oc-author', comment.author || 'Unknown'));
  row.appendChild(head);
  row.appendChild(el('p', 'oc-text', comment.text));
  return row;
}

// Groups the flat openComments list by spec section so a reviewer reads all the
// open threads on one section together (the report returns them spec-ordered).
function groupBySection(comments) {
  const groups = new Map();
  for (const comment of comments) {
    const key = comment.specSection;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(comment);
  }
  return [...groups.entries()];
}

export function renderOpenComments(container, report, ctx = {}) {
  container.replaceChildren();
  if (!report) {
    container.appendChild(el('p', 'coord-empty', 'Open comments unavailable in this build.'));
    return;
  }

  const summary = el('div', 'coord-summary');
  summary.appendChild(el('span', 'coord-total', `${report.summary.open} OPEN`));
  summary.appendChild(el('span', 'coord-chip', `${report.summary.total} TOTAL`));
  container.appendChild(summary);

  if (report.openComments.length === 0) {
    container.appendChild(el('p', 'coord-empty', 'No unresolved review comments in this project.'));
    return;
  }

  const list = el('div', 'oc-list');
  for (const [section, comments] of groupBySection(report.openComments)) {
    const group = el('section', 'oc-group');
    const head = el('div', 'oc-group-head');
    head.appendChild(sectionButton(section, ctx));
    head.appendChild(el('span', 'oc-group-count', `${comments.length} open`));
    group.appendChild(head);
    const items = el('ul', 'oc-comment-list');
    for (const comment of comments) items.appendChild(renderComment(comment, ctx));
    group.appendChild(items);
    list.appendChild(group);
  }
  container.appendChild(list);
}
