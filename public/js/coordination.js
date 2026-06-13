function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const GROUPS = [
  {
    type: 'present_not_required',
    title: 'PRESENT, NOT REQUIRED',
    empty: 'No loaded sections fall outside the authored required list.',
  },
  {
    type: 'required_not_present',
    title: 'REQUIRED, NOT PRESENT',
    empty: 'No authored required sections are missing from the loaded set.',
  },
  {
    type: 'dangling_ref',
    title: 'DANGLING CROSS-REFERENCES',
    empty: 'No loaded section cites a section outside this scope.',
  },
];

function sectionButton(section, ctx) {
  const btn = el('button', 'coord-section', section);
  btn.type = 'button';
  btn.addEventListener('click', () => ctx.onNavigate?.(section));
  return btn;
}

function findingSection(finding) {
  if (finding.type === 'dangling_ref') return finding.targetSpecSection;
  return finding.section;
}

function renderFinding(finding, ctx) {
  const row = el('li', `coord-finding is-${finding.type}`);
  if (finding.type === 'present_not_required') {
    row.appendChild(sectionButton(finding.section, ctx));
    row.appendChild(el('span', 'coord-text', finding.title));
    return row;
  }
  if (finding.type === 'required_not_present') {
    row.appendChild(sectionButton(finding.section, ctx));
    row.appendChild(el('span', 'coord-text', finding.title || 'Required section has no title'));
    return row;
  }
  row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
  row.appendChild(el('span', 'coord-arrow', 'cites'));
  row.appendChild(el('span', 'coord-target', finding.targetSpecSection || 'unknown'));
  row.appendChild(el('span', 'coord-text', finding.referenceText));
  return row;
}

function renderGroup(report, group, ctx) {
  const findings = report.findings.filter((finding) => finding.type === group.type);
  const wrap = el('section', 'coord-group');
  const head = el('button', 'coord-group-head');
  head.type = 'button';
  head.appendChild(el('span', 'coord-group-title', group.title));
  head.appendChild(el('span', 'coord-group-count', String(findings.length)));
  head.addEventListener('click', () => wrap.classList.toggle('is-closed'));
  wrap.appendChild(head);

  const list = el('ul', 'coord-list');
  if (findings.length === 0) {
    list.appendChild(el('li', 'coord-empty', group.empty));
  } else {
    for (const finding of findings) {
      const row = renderFinding(finding, ctx);
      const target = findingSection(finding);
      if (target) row.dataset.section = target;
      list.appendChild(row);
    }
  }
  wrap.appendChild(list);
  return wrap;
}

export function renderCoordinationReport(container, report, ctx = {}) {
  container.replaceChildren();
  if (!report) {
    container.appendChild(el('p', 'coord-empty', 'Coordination report unavailable.'));
    return;
  }

  const summary = el('div', 'coord-summary');
  summary.appendChild(el('span', 'coord-total', `${report.summary.total} TOTAL`));
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.presentNotRequired} PRESENT NOT REQUIRED`)
  );
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.requiredNotPresent} REQUIRED NOT PRESENT`)
  );
  summary.appendChild(el('span', 'coord-chip', `${report.summary.danglingRef} DANGLING REFS`));
  container.appendChild(summary);

  if (report.notes.length > 0) {
    const notes = el('div', 'coord-notes');
    for (const note of report.notes) notes.appendChild(el('p', null, note));
    container.appendChild(notes);
  }

  for (const group of GROUPS) container.appendChild(renderGroup(report, group, ctx));
}
