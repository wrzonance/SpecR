import { API_FEATURES } from './features.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BASE_GROUPS = [
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
  {
    type: 'related_listed_not_cited',
    title: 'LISTED IN RELATED SECTIONS, NOT CITED',
    empty: 'Every Related Sections entry is cited somewhere in its spec body.',
  },
  {
    type: 'related_cited_not_listed',
    title: 'CITED IN BODY, NOT IN RELATED SECTIONS',
    empty: 'Every section cited in a body is also listed under Related Sections.',
  },
  {
    type: 'standard_cited_not_listed',
    title: 'STANDARD CITED, NOT IN REFERENCES',
    empty: 'Every standard cited in a body is also listed under References.',
  },
  {
    type: 'implied_related_section',
    title: 'IMPLIED RELATED SECTION (NOT LISTED)',
    empty: 'No body concept implies an unlisted Related Section.',
    flag: 'impliedRelated',
  },
  {
    type: 'umbrella_not_called_out',
    title: 'UMBRELLA NOT CALLED OUT',
    empty: 'Every subordinate section references its division umbrella.',
    flag: 'umbrellaCallout',
  },
];

const SUBMITTAL_GROUPS = [
  {
    type: 'product_without_submittal_type',
    title: 'PRODUCT WITHOUT SUBMITTAL TYPE',
    empty: 'Every specified product has at least one required submittal type.',
  },
  {
    type: 'submittal_type_without_product',
    title: 'SUBMITTAL TYPE WITHOUT PRODUCT',
    empty: 'Every required submittal type has a Part 2 product candidate.',
  },
  {
    type: 'product_missing_datasheet',
    title: 'PRODUCT MISSING DATASHEET',
    empty: 'Every specified product has a datasheet association.',
  },
];

const GROUPS = API_FEATURES.submittalRegister ? [...BASE_GROUPS, ...SUBMITTAL_GROUPS] : BASE_GROUPS;

function sectionButton(section, ctx) {
  const btn = el('button', 'coord-section', section);
  btn.type = 'button';
  btn.addEventListener('click', () => ctx.onNavigate?.(section));
  return btn;
}

function findingSection(finding) {
  if (finding.type === 'dangling_ref') return finding.targetSpecSection;
  if (finding.type === 'standard_cited_not_listed') return finding.sourceSpecSection;
  if (finding.type === 'implied_related_section') return finding.impliedSection;
  if (finding.type === 'umbrella_not_called_out') return finding.sourceSpecSection;
  return finding.section;
}

// The sheet a finding belongs to, for tree grouping. sourceSpecSection is present
// on every body-derived finding; present/required_not_present carry finding.section.
const NO_SECTION = '—';
function groupingSection(finding) {
  return finding.sourceSpecSection ?? finding.section ?? NO_SECTION;
}

// CSI division = first two digits of "NN NN NN"; anything else buckets last.
function divisionOf(section) {
  return /^\d{2}/.test(section) ? section.slice(0, 2) : NO_SECTION;
}

// Sort division/section keys ascending, with the section-less bucket ('—') last.
function sortedBucketKeys(map) {
  return [...map.keys()].sort((a, b) => {
    if (a === NO_SECTION) return 1;
    if (b === NO_SECTION) return -1;
    return a.localeCompare(b);
  });
}

function visibleGroups() {
  return GROUPS.filter((group) => !group.flag || API_FEATURES[group.flag]);
}

// Stamp the finding→spec-pane anchor so the audit view can drive the right pane
// (ADR-041): data-spec-id + data-paragraph-id scroll to the exact paragraph
// (present on dangling_ref / implied / submittal-product findings); data-section
// drives bidirectional reflection. is-locatable marks the row interactive.
function stampAnchor(row, finding) {
  const target = findingSection(finding);
  if (target) row.dataset.section = target;
  const specId = finding.sourceSpecId ?? finding.specId;
  if (specId) row.dataset.specId = specId;
  if (finding.sourceParagraphId) row.dataset.paragraphId = finding.sourceParagraphId;
  row.classList.add('is-locatable');
}

// The #259 article<->body consistency findings: source spec section, the
// relationship, and the cited/listed target (a section number or standard code).
const REFERENCE_FINDINGS = {
  related_listed_not_cited: { arrow: 'lists (uncited)', target: (f) => f.section },
  related_cited_not_listed: { arrow: 'cites (unlisted)', target: (f) => f.section },
  standard_cited_not_listed: { arrow: 'cites (unlisted)', target: (f) => f.standardCode },
};

function renderReferenceFinding(finding, ctx, shape) {
  const row = el('li', `coord-finding is-${finding.type}`);
  row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
  row.appendChild(el('span', 'coord-arrow', shape.arrow));
  row.appendChild(el('span', 'coord-target', shape.target(finding) || 'unknown'));
  return row;
}

// Dangling cross-reference (#269): source section cites a target outside scope.
// The finding now carries a paragraph-level locator (sourceParagraphId) and a
// snippet — a short excerpt of the citing paragraph centred on the reference —
// so the reviewer sees WHERE and HOW the dangling citation reads, not just that
// it exists. The section button navigates to the source sheet (section-level);
// the snippet supplies the in-paragraph context.
function renderDanglingRef(finding, ctx) {
  const row = el('li', `coord-finding is-${finding.type}`);
  const head = el('div', 'coord-finding-head');
  head.appendChild(sectionButton(finding.sourceSpecSection, ctx));
  head.appendChild(el('span', 'coord-arrow', 'cites'));
  head.appendChild(el('span', 'coord-target', finding.targetSpecSection || 'unknown'));
  head.appendChild(el('span', 'coord-text', finding.referenceText));
  row.appendChild(head);
  if (finding.snippet) {
    const snippet = el('p', 'coord-snippet', finding.snippet);
    snippet.title = 'Excerpt of the citing paragraph (centred on the reference)';
    row.appendChild(snippet);
  }
  return row;
}

function renderImpliedRelatedSection(finding, ctx) {
  const row = el('li', `coord-finding is-${finding.type}`);
  row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
  row.appendChild(el('span', 'coord-arrow', 'mentions'));
  row.appendChild(el('span', 'coord-target', finding.matchedKeyword || 'unknown'));
  row.appendChild(el('span', 'coord-arrow', 'implies'));
  row.appendChild(
    el('span', 'coord-text', `${finding.impliedSection} ${finding.impliedTitle}`.trim())
  );
  return row;
}

function renderUmbrellaNotCalledOut(finding, ctx) {
  const row = el('li', `coord-finding is-${finding.type}`);
  row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
  row.appendChild(el('span', 'coord-arrow', 'missing call-out →'));
  row.appendChild(el('span', 'coord-target', finding.umbrellaSpecSection || 'unknown'));
  return row;
}

function renderFinding(finding, ctx) {
  const reference = REFERENCE_FINDINGS[finding.type];
  if (reference) return renderReferenceFinding(finding, ctx, reference);
  if (finding.type === 'dangling_ref') return renderDanglingRef(finding, ctx);
  if (finding.type === 'implied_related_section') {
    return renderImpliedRelatedSection(finding, ctx);
  }
  if (finding.type === 'umbrella_not_called_out') return renderUmbrellaNotCalledOut(finding, ctx);

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
  if (finding.type === 'product_without_submittal_type') {
    row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
    row.appendChild(el('span', 'coord-arrow', 'specifies'));
    row.appendChild(el('span', 'coord-target', finding.productName));
    row.appendChild(el('span', 'coord-text', 'No required submittal type'));
    return row;
  }
  if (finding.type === 'submittal_type_without_product') {
    row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
    row.appendChild(el('span', 'coord-arrow', 'requires'));
    row.appendChild(el('span', 'coord-target', finding.submittalType));
    row.appendChild(el('span', 'coord-text', 'No Part 2 product'));
    return row;
  }
  if (finding.type === 'product_missing_datasheet') {
    row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
    row.appendChild(el('span', 'coord-arrow', 'missing datasheet'));
    row.appendChild(el('span', 'coord-target', finding.productName));
    return row;
  }
  row.appendChild(sectionButton(finding.sourceSpecSection, ctx));
  row.appendChild(el('span', 'coord-arrow', 'cites'));
  row.appendChild(el('span', 'coord-target', finding.targetSpecSection || 'unknown'));
  row.appendChild(el('span', 'coord-text', finding.referenceText));
  return row;
}

// A collapsible shell (rotating chevron + title + count) reused at all three
// report levels: category (.coord-group), division (.coord-div), section
// (.coord-sec). aria-expanded is synced to the chevron for keyboard/SR users.
// The group level keeps the exact markup the audit view (audit.js) keys on.
function collapsibleShell(levelClass, title, count) {
  const wrap = el('section', levelClass);
  const head = el('button', `${levelClass}-head`);
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  const headline = el('span', 'coord-group-headline');
  headline.appendChild(el('span', 'coord-twist', '▼'));
  headline.appendChild(el('span', 'coord-group-title', title));
  head.appendChild(headline);
  head.appendChild(el('span', 'coord-group-count', String(count)));
  head.addEventListener('click', () => {
    const closed = wrap.classList.toggle('is-closed');
    head.setAttribute('aria-expanded', String(!closed));
  });
  wrap.appendChild(head);
  const body = el('div', `${levelClass}-body`);
  wrap.appendChild(body);
  return { wrap, body };
}

function findingRows(findings, ctx) {
  const list = el('ul', 'coord-list');
  for (const finding of findings) {
    const row = renderFinding(finding, ctx);
    stampAnchor(row, finding);
    list.appendChild(row);
  }
  return list;
}

// Bucket a category's findings into division → section → finding[] so the report
// is a 3-level collapsible tree that very large projects can fold at any level.
function bucketByDivisionSection(findings) {
  const byDivision = new Map();
  for (const finding of findings) {
    const section = groupingSection(finding);
    const division = divisionOf(section);
    if (!byDivision.has(division)) byDivision.set(division, new Map());
    const bySection = byDivision.get(division);
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(finding);
  }
  return byDivision;
}

function renderDivision(division, bySection, ctx) {
  const total = [...bySection.values()].reduce((n, rows) => n + rows.length, 0);
  const label = division === NO_SECTION ? 'NO DIVISION' : `DIVISION ${division}`;
  const { wrap, body } = collapsibleShell('coord-div', label, total);
  const secList = el('div', 'coord-sec-list');
  for (const section of sortedBucketKeys(bySection)) {
    const rows = bySection.get(section);
    const sec = collapsibleShell('coord-sec', section, rows.length);
    sec.body.appendChild(findingRows(rows, ctx));
    secList.appendChild(sec.wrap);
  }
  body.appendChild(secList);
  return wrap;
}

function renderGroup(report, group, ctx) {
  const findings = report.findings.filter((finding) => finding.type === group.type);
  const { wrap, body } = collapsibleShell('coord-group', group.title, findings.length);

  // Empty category: keep the flat one-line message (no division/section levels).
  if (findings.length === 0) {
    const list = el('ul', 'coord-list');
    list.appendChild(el('li', 'coord-empty', group.empty));
    body.appendChild(list);
    return wrap;
  }

  const byDivision = bucketByDivisionSection(findings);
  const divList = el('div', 'coord-div-list');
  for (const division of sortedBucketKeys(byDivision)) {
    divList.appendChild(renderDivision(division, byDivision.get(division), ctx));
  }
  body.appendChild(divList);
  return wrap;
}

// The finding total the user can actually see: the backend total minus any groups
// the demo hides via API_FEATURES (e.g. impliedRelated is suppressed as a known
// false-positive, #327). Without this, a project whose only finding is hidden shows
// a nonzero red total with no inspectable row.
export function visibleCoordinationTotal(report) {
  const hiddenImplied = API_FEATURES.impliedRelated
    ? 0
    : (report.summary.impliedRelatedSection ?? 0);
  return Math.max(0, report.summary.total - hiddenImplied);
}

export function renderCoordinationReport(container, report, ctx = {}) {
  container.replaceChildren();
  if (!report) {
    container.appendChild(el('p', 'coord-empty', 'Coordination report unavailable.'));
    return;
  }

  const summary = el('div', 'coord-summary');
  summary.appendChild(el('span', 'coord-total', `${visibleCoordinationTotal(report)} TOTAL`));
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.presentNotRequired} PRESENT NOT REQUIRED`)
  );
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.requiredNotPresent} REQUIRED NOT PRESENT`)
  );
  summary.appendChild(el('span', 'coord-chip', `${report.summary.danglingRef} DANGLING REFS`));
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.relatedListedNotCited} LISTED NOT CITED`)
  );
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.relatedCitedNotListed} CITED NOT LISTED`)
  );
  summary.appendChild(
    el('span', 'coord-chip', `${report.summary.standardCitedNotListed} STD CITED NOT LISTED`)
  );
  if (API_FEATURES.submittalRegister) {
    summary.appendChild(
      el('span', 'coord-chip', `${report.summary.productMissingDatasheet ?? 0} NO DATASHEET`)
    );
    summary.appendChild(
      el('span', 'coord-chip', `${report.summary.productWithoutSubmittalType ?? 0} PRODUCT NO TYPE`)
    );
  }
  if (API_FEATURES.impliedRelated) {
    summary.appendChild(
      el('span', 'coord-chip', `${report.summary.impliedRelatedSection || 0} IMPLIED RELATED`)
    );
  }
  if (API_FEATURES.umbrellaCallout) {
    summary.appendChild(
      el('span', 'coord-chip', `${report.summary.umbrellaNotCalledOut || 0} UMBRELLA CALLOUTS`)
    );
  }
  container.appendChild(summary);

  if (report.notes.length > 0) {
    const notes = el('div', 'coord-notes');
    for (const note of report.notes) notes.appendChild(el('p', null, note));
    container.appendChild(notes);
  }

  for (const group of visibleGroups()) container.appendChild(renderGroup(report, group, ctx));
}
