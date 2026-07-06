// SpecR Section Linkage Console — entry point and state.
//
// State is a Map of specId -> { tree, references, warnings?, capabilities? }.
// Every mutation rebuilds the reference web and re-resolves the link status
// of every sheet, so dropping a cited section "heals" links board-wide.

import {
  checkHealth,
  getSpecTree,
  getOutboundReferences,
  deleteParagraph,
  setParagraphRemoved,
  updateParagraph,
  deleteSpec,
  createProject,
  listProjects,
  getProject,
  patchProject,
  setProjectSources,
  listLibraries,
  createClientLibrary,
  renameLibrary,
  listLibrarySpecs,
  addSpecToProject,
  removeSpecFromProject,
  getBrokenRefs,
  getCoordinationReport,
  getSubmittalRegister,
  getProjectOpenComments,
  getRequiredSections,
  setRequiredSections,
  deleteProject,
} from './api.js';
import { renderSpecSheet } from './tree.js';
import { API_FEATURES } from './features.js';
import { buildWebModel, renderWeb } from './web.js';
import { renderCoordinationReport, visibleCoordinationTotal } from './coordination.js';
import { renderOpenComments } from './open-comments.js';
import { renderSubmittalRegister } from './submittal.js';
import { initNumbering } from './numbering.js';
import { initChat } from './chat.js';
import { initCompose } from './compose.js';
import { initDropzone } from './dropzone.js';
import { initRefPopover } from './popover.js';
import { initAudit } from './audit.js';
import { initEditor } from './editor.js';
import { initConstellation } from './constellation.js';
import { openConfirm, openChoice, openPicker } from './modal.js';

const specs = new Map(); // specId -> { tree, references, warnings?, capabilities? }
const ACTIVE_PROJECT_KEY = 'specr-active-project';
const LEGACY_PROJECT_KEY = 'specr-demo-project';
const LIBRARY_ONLY_KEY = 'specr-library-only-specs';
let activeProjectId = null;
let activeProject = null;
let projects = [];
let currentView = 'map';
let numberingPanel = null; // numbering-profile workspace controller (initNumbering)
let audit = null; // live coordination audit view controller (initAudit, ADR-041)
let composePanel = null; // agent-driven grounded reporting controller (initCompose, #353)
let editorPanel = null; // full-page document editor controller (initEditor, #369)
let constellationPanel = null; // division solar-system map controller (initConstellation, #369)
let tocSections = [];
const tocCollapsedDivisions = new Set();
let libraries = [];
let selectedLibraryId = null;
let selectedLibrarySpecs = [];
let projectClientLibraryIds = [];
let tocLibrarySpecs = [];
const board = document.getElementById('spec-board');
const emptyState = document.getElementById('empty-state');
const webCanvas = document.getElementById('ref-web-canvas');
const webHint = document.getElementById('web-hint');
const coordBody = document.getElementById('coord-report-body');
const openCommentsBody = document.getElementById('open-comments-body');
const submittalRegisterBody = document.getElementById('submittal-register-body');

const COMPANY_MASTER_NAME = 'Default Company Master';
const DEMO_CLIENT_NAMES = ['Alameda Civic Partners', 'Northbank Health', 'Vireo Schools'];

function toast(message, kind = 'info') {
  const rack = document.getElementById('toast-rack');
  const node = document.createElement('div');
  node.className = `toast${kind === 'warn' ? ' is-warn' : ''}${kind === 'err' ? ' is-err' : ''}`;
  node.textContent = message;
  rack.appendChild(node);
  setTimeout(() => node.remove(), 5200);
}

function readLibraryOnlyIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIBRARY_ONLY_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeLibraryOnlyIds(ids) {
  localStorage.setItem(LIBRARY_ONLY_KEY, JSON.stringify([...ids]));
}

function markLibraryOnly(specId) {
  const ids = readLibraryOnlyIds();
  ids.add(specId);
  writeLibraryOnlyIds(ids);
}

function markProjectVisible(specId) {
  const ids = readLibraryOnlyIds();
  ids.delete(specId);
  writeLibraryOnlyIds(ids);
}

function showView(view) {
  currentView = view;
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    panel.hidden = panel.dataset.viewPanel !== view;
    panel.classList.toggle('is-active', panel.dataset.viewPanel === view);
  }
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.classList.toggle('is-active', tab.dataset.view === view);
  }
  if (view === 'numbering') void numberingPanel?.refresh();
  if (view === 'submittal') void refreshSubmittalRegister();
  if (view === 'compose') composePanel?.refresh();
  // The audit's findings already repaint on workspace load / spec mutations;
  // opening the tab just needs a height re-measure. (A refetch here would wipe
  // the current finding selection and desync the two panes.)
  if (view === 'report') audit?.fit();
  if (view === 'editor') editorPanel?.refresh();
  if (view === 'constellation') constellationPanel?.refresh();
  updateAddFabVisibility();
}

function initNavigation() {
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
}

function updateAddFabVisibility() {
  const add = document.getElementById('add-fab');
  if (add) add.hidden = currentView !== 'map';
}

// ── Active project ─────────────────────────────────────────────────────────

const projectMembers = new Set(); // spec ids known to be in the active project
const SECTION_PARTS_RE = /^(\d{2}) (\d{2}) (\d{2})(\.\d{2})?( \d{2})?$/;

function savedProjectId() {
  return localStorage.getItem(ACTIVE_PROJECT_KEY) || localStorage.getItem(LEGACY_PROJECT_KEY);
}

function rememberProject(projectId) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  localStorage.setItem(LEGACY_PROJECT_KEY, projectId);
}

function activeProjectName() {
  return (
    activeProject?.name ||
    projects.find((project) => project.id === activeProjectId)?.name ||
    'Project'
  );
}

function activeSectionNumberFormat() {
  return (
    activeProject?.sectionNumberFormat ||
    projects.find((project) => project.id === activeProjectId)?.sectionNumberFormat ||
    'canonical'
  );
}

function displaySection(section) {
  const match = SECTION_PARTS_RE.exec(section);
  if (!match) return section;
  const first = match[1] || '';
  const second = match[2] || '';
  const third = match[3] || '';
  const suffix = match[4] || '';
  const agency = match[5] || '';
  switch (activeSectionNumberFormat()) {
    case 'dots':
      return `${first}.${second}.${third}${suffix}${agency}`;
    case 'compact':
      return `${first}${second}${third}${suffix}${agency}`;
    case 'spaced-compact':
      return `${first} ${second}${third}${suffix}${agency}`;
    default:
      return section;
  }
}

function defaultProjectSourceIds() {
  const company = companyMaster();
  return company ? [company.id] : [];
}

function projectClientSourceIds(project = activeProject) {
  return (project?.sources ?? [])
    .filter((source) => source.tier === 'client')
    .map((source) => source.libraryId);
}

function projectSourceIds() {
  const company = companyMaster();
  return [...new Set([...projectClientLibraryIds, ...(company ? [company.id] : [])])];
}

function projectSourceLabel() {
  const clientCount = projectClientLibraryIds.length;
  if (clientCount === 0) return 'Company Masters';
  return `${clientCount} Client Master${clientCount === 1 ? '' : 's'} + Company Masters`;
}

async function refreshProjectList(preferredId = activeProjectId) {
  projects = await listProjects();
  const saved = preferredId || savedProjectId();
  if (saved && projects.some((project) => project.id === saved)) {
    activeProjectId = saved;
  } else {
    activeProjectId = projects[0]?.id || null;
  }
  renderProjectControls();
}

async function createDefaultProject() {
  const sourceIds = defaultProjectSourceIds();
  if (sourceIds.length === 0) throw new Error('Default Company Master library not found');
  const project = await createProject(
    'SpecR Demo Board',
    'Auto-managed membership for the linkage console demo',
    sourceIds
  );
  activeProjectId = project.projectId;
  rememberProject(activeProjectId);
  await refreshProjectList(activeProjectId);
}

async function ensureActiveProject() {
  try {
    await refreshProjectList();
    if (!activeProjectId) await createDefaultProject();
    if (activeProjectId) rememberProject(activeProjectId);
  } catch (err) {
    activeProjectId = null;
    activeProject = null;
    toast(`could not initialize project workspace: ${err.message}`, 'warn');
  }
}

function renderProjectControls() {
  const select = document.getElementById('project-select');
  const rename = document.getElementById('project-rename');
  const format = document.getElementById('project-format-pill');
  const source = document.getElementById('project-source-pill');
  if (select) {
    select.replaceChildren();
    for (const project of projects) {
      const opt = document.createElement('option');
      opt.value = project.id;
      opt.textContent = project.name;
      opt.selected = project.id === activeProjectId;
      select.appendChild(opt);
    }
    select.disabled = projects.length === 0;
  }
  if (rename) rename.disabled = !activeProjectId;
  if (format) format.textContent = displaySection('09 91 00');
  if (source) source.textContent = projectSourceLabel();
  renderProjectSettings();
}

function renderProjectSettings() {
  const name = document.getElementById('project-name-input');
  const formatSelect = document.getElementById('project-format-select');
  const hint = document.getElementById('settings-hint');
  if (name) name.value = activeProjectName();
  if (formatSelect) formatSelect.value = activeSectionNumberFormat();
  if (hint) hint.textContent = `${activeProjectName()} · ${projectSourceLabel()}`;
  renderProjectSourceList();
}

function renderProjectSourceList() {
  const list = document.getElementById('project-source-list');
  if (!list) return;
  list.replaceChildren();
  const company = companyMaster();
  if (company) {
    const companyRow = renderSourceRow(company, true, true);
    list.appendChild(companyRow);
  }
  const clients = clientLibraries();
  if (clients.length === 0) {
    list.appendChild(makeNode('p', 'library-empty', 'No client libraries yet.'));
    return;
  }
  for (const client of clients) {
    list.appendChild(renderSourceRow(client, projectClientLibraryIds.includes(client.id), false));
  }
}

function renderSourceRow(library, checked, disabled) {
  const label = makeNode('label', 'source-row');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = library.id;
  input.checked = checked;
  input.disabled = disabled;
  input.dataset.projectSource = library.id;
  label.appendChild(input);
  label.appendChild(makeNode('span', 'source-name', library.name));
  label.appendChild(
    makeNode('span', 'source-tier', library.tier === 'client' ? 'CLIENT' : 'COMPANY')
  );
  return label;
}

function checkedProjectClientIds() {
  return [...document.querySelectorAll('[data-project-source]')]
    .filter((input) => input instanceof HTMLInputElement && input.checked && !input.disabled)
    .map((input) => input.value);
}

async function switchProject(projectId) {
  if (!projectId || projectId === activeProjectId) return;
  activeProjectId = projectId;
  rememberProject(projectId);
  await loadActiveProjectWorkspace();
  toast(`Switched to ${activeProjectName()}`);
}

async function createProjectFromUi() {
  const name = await modalText({
    title: 'New project',
    label: 'Project name',
    value: '',
    confirmLabel: 'Create',
  });
  if (!name) return;
  try {
    const project = await createProject(
      name,
      'Mockup project workspace',
      defaultProjectSourceIds()
    );
    activeProjectId = project.projectId;
    rememberProject(activeProjectId);
    await refreshProjectList(project.projectId);
    await loadActiveProjectWorkspace();
    toast(`Project ${project.name} added`);
  } catch (err) {
    toast(`project add failed: ${err.message}`, 'err');
  }
}

async function renameActiveProject() {
  if (!activeProjectId) return;
  if (!API_FEATURES.projectSettings) {
    toast('Project rename is not available in this API build', 'warn');
    return;
  }
  const name = await modalText({
    title: 'Rename project',
    label: 'Project name',
    value: activeProjectName(),
    confirmLabel: 'Rename',
  });
  if (!name || name === activeProjectName()) return;
  try {
    await patchProject(activeProjectId, { name });
    await refreshProjectList(activeProjectId);
    activeProject = await getProject(activeProjectId);
    renderProjectControls();
    toast(`Project renamed to ${name}`);
  } catch (err) {
    toast(`rename failed: ${err.message}`, 'err');
  }
}

async function saveProjectSettings() {
  if (!activeProjectId) return;
  if (!API_FEATURES.projectSettings) {
    toast('Project settings are not available in this API build', 'warn');
    return;
  }
  const name = document.getElementById('project-name-input')?.value.trim() || activeProjectName();
  const formatSelect = document.getElementById('project-format-select');
  const sectionNumberFormat = formatSelect?.value || activeSectionNumberFormat();
  projectClientLibraryIds = checkedProjectClientIds();
  try {
    await patchProject(activeProjectId, { name, sectionNumberFormat });
    await syncProjectSourcesToTocScope();
    await refreshProjectList(activeProjectId);
    activeProject = await getProject(activeProjectId);
    projectClientLibraryIds = projectClientSourceIds(activeProject);
    renderProjectControls();
    await refreshTocClientScope();
    await refreshTocLibrarySpecs();
    renderBoard();
    await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    await refreshSubmittalRegister();
    toast('Project settings saved');
  } catch (err) {
    toast(`settings save failed: ${err.message}`, 'err');
  }
}

async function loadActiveProjectWorkspace() {
  editorPanel?.reset();
  specs.clear();
  projectMembers.clear();
  tocSections = [];
  try {
    activeProject = activeProjectId ? await getProject(activeProjectId) : null;
    projectClientLibraryIds = projectClientSourceIds(activeProject);
    if (activeProject && (activeProject.sources ?? []).length === 0) {
      await syncProjectSourcesToTocScope();
      activeProject = await getProject(activeProjectId);
      projectClientLibraryIds = projectClientSourceIds(activeProject);
    }
    renderProjectControls();
    await refreshTocClientScope();
    await refreshTocLibrarySpecs();
    await refreshTocBuilder();
    await restoreProjectSpecs(activeProject);
  } catch (err) {
    toast(`could not load project: ${err.message}`, 'warn');
  }
  renderBoard();
  await refreshBrokenCount();
  await refreshCoordination();
  await refreshOpenComments();
  await refreshSubmittalRegister();
}

async function deleteActiveProject() {
  if (!activeProjectId) return;
  const ok = await openConfirm({
    title: 'Delete project',
    body: [
      { text: `Delete "${activeProjectName()}"?`, kind: 'strong' },
      {
        text: 'The project is soft-deleted and hidden from the list. You can restore it later.',
        kind: 'muted',
      },
    ],
    confirmLabel: 'Delete project',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteProject(activeProjectId, 'demo-user');
    const deletedId = activeProjectId;
    activeProjectId = null;
    activeProject = null;
    await refreshProjectList();
    if (activeProjectId) rememberProject(activeProjectId);
    // loadActiveProjectWorkspace clears specs/members/board when no project
    // remains, and loads the next project's workspace otherwise.
    await loadActiveProjectWorkspace();
    toast(`Project deleted`, 'warn');
    const undoMsg = document.createElement('span');
    undoMsg.textContent = ' ';
    const undoBtn = document.createElement('button');
    undoBtn.textContent = 'Undo';
    undoBtn.style.cssText =
      'margin-left:6px;text-decoration:underline;background:none;border:none;color:inherit;cursor:pointer;';
    undoBtn.addEventListener('click', async () => {
      try {
        const { restoreProject: restore } = await import('./api.js');
        await restore(deletedId);
        await refreshProjectList(deletedId);
        rememberProject(deletedId);
        // switchProject would early-return (id is already active after refresh),
        // so load the restored workspace directly.
        await loadActiveProjectWorkspace();
        toast('Project restored');
      } catch (err) {
        toast(`restore failed: ${err.message}`, 'err');
      }
    });
    const rack = document.getElementById('toast-rack');
    if (rack) {
      const node = rack.lastElementChild;
      if (node) {
        node.appendChild(undoMsg);
        node.appendChild(undoBtn);
      }
    }
  } catch (err) {
    toast(`delete failed: ${err.message}`, 'err');
  }
}

function initProjectManager() {
  document.getElementById('project-select')?.addEventListener('change', (event) => {
    void switchProject(event.target.value);
  });
  document.getElementById('project-add')?.addEventListener('click', () => {
    void createProjectFromUi();
  });
  document.getElementById('project-rename')?.addEventListener('click', () => {
    void renameActiveProject();
  });
  document.getElementById('project-settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveProjectSettings();
  });
  document.getElementById('project-delete-btn')?.addEventListener('click', () => {
    void deleteActiveProject();
  });
}

async function joinProject(specId) {
  if (!activeProjectId || projectMembers.has(specId)) return specId;
  const spec = specs.get(specId);
  const section = spec?.tree?.section;
  if (!section) return specId;
  try {
    const result = await addSpecToProject(activeProjectId, section);
    projectMembers.add(result.specId);
    if (result.specId !== specId) {
      specs.delete(specId);
      await addSpec(result.specId);
    }
    return result.specId;
  } catch (err) {
    if (err.status === 409) {
      const project = await getProject(activeProjectId);
      const existing = (project.toc ?? []).find((entry) => entry.section === section);
      if (existing) {
        projectMembers.add(existing.specId);
        if (existing.specId !== specId) {
          specs.delete(specId);
          await addSpec(existing.specId);
        }
        return existing.specId;
      }
    } else {
      console.warn(`SpecR: could not add ${section} to active project`, err);
    }
  }
  return specId;
}

// Updates the masthead BROKEN REFS cell from the server's count. Returns it.
async function refreshBrokenCount() {
  const cell = document.getElementById('broken-cell');
  const out = document.getElementById('broken-count');
  if (!activeProjectId) return 0;
  try {
    const broken = await getBrokenRefs(activeProjectId);
    if (out) out.textContent = String(broken.length);
    if (cell) cell.classList.toggle('is-broken', broken.length > 0);
    return broken.length;
  } catch {
    return null;
  }
}

async function refreshCoordination() {
  const cell = document.getElementById('coord-cell');
  const out = document.getElementById('coord-count');
  if (!activeProjectId) return null;
  if (!API_FEATURES.coordination) {
    if (coordBody) renderCoordinationReport(coordBody, null);
    return null;
  }
  try {
    const report = await getCoordinationReport(activeProjectId);
    const total = visibleCoordinationTotal(report);
    if (out) out.textContent = String(total);
    if (cell) cell.classList.toggle('is-broken', total > 0);
    // No onNavigate: in the audit view (ADR-041) the delegated handler on
    // #audit-findings drives the spec pane; the section buttons stay in-place.
    if (coordBody) renderCoordinationReport(coordBody, report);
    return total;
  } catch (err) {
    if (coordBody) renderCoordinationReport(coordBody, null);
    console.warn('SpecR: could not refresh coordination report', err);
    return null;
  }
}

function selectedSubmittalSpecIds() {
  return [...specs.keys()].filter((specId) => projectMembers.has(specId));
}

async function refreshSubmittalRegister() {
  if (!activeProjectId) return null;
  if (!API_FEATURES.submittalRegister) {
    if (submittalRegisterBody) renderSubmittalRegister(submittalRegisterBody, null);
    return null;
  }
  try {
    const report = await getSubmittalRegister(activeProjectId, selectedSubmittalSpecIds());
    if (submittalRegisterBody) {
      renderSubmittalRegister(submittalRegisterBody, report, {
        onNavigate: navigateToSection,
        displaySection,
      });
    }
    return report.summary.rows;
  } catch (err) {
    if (submittalRegisterBody) renderSubmittalRegister(submittalRegisterBody, null);
    console.warn('SpecR: could not refresh submittal register', err);
    return null;
  }
}

// Pulls the project-scoped open-comments report (#272) and paints both the
// masthead OPEN CMTS cell and the Report-view panel. Mirrors refreshCoordination:
// degrades to an "unavailable" panel when the flag is off and never throws.
async function refreshOpenComments() {
  const cell = document.getElementById('comments-cell');
  const out = document.getElementById('comments-count');
  if (!activeProjectId) return null;
  if (!API_FEATURES.openComments) {
    if (openCommentsBody) renderOpenComments(openCommentsBody, null);
    return null;
  }
  try {
    const report = await getProjectOpenComments(activeProjectId);
    if (out) out.textContent = String(report.summary.open);
    if (cell) cell.classList.toggle('is-broken', report.summary.open > 0);
    if (openCommentsBody) {
      // Open-comments badges open the section in the audit spec pane rather than
      // jumping to the map, so the reviewer stays in the Report (ADR-041).
      renderOpenComments(openCommentsBody, report, {
        onNavigate: (section) => void audit?.showSection(section),
        displaySection,
      });
    }
    return report.summary.open;
  } catch (err) {
    if (openCommentsBody) renderOpenComments(openCommentsBody, null);
    console.warn('SpecR: could not refresh open comments', err);
    return null;
  }
}

async function refreshDiagnostics() {
  const [brokenCount, coordinationCount, openComments, submittalRows] = await Promise.all([
    refreshBrokenCount(),
    refreshCoordination(),
    refreshOpenComments(),
    refreshSubmittalRegister(),
  ]);
  return { brokenCount, coordinationCount, openComments, submittalRows };
}

// ── State refresh ───────────────────────────────────────────────────────────

// Per-spec outbound references are project-scoped (ADR-024) — the single-spec
// read no longer bundles them, so fetch them for project specs to feed the web's
// arcs. Library-only specs (404 "spec not in project") simply have none.
async function loadSpecReferences(specId) {
  if (!activeProjectId) return [];
  try {
    return await getOutboundReferences(activeProjectId, specId);
  } catch {
    return [];
  }
}

async function reloadSpec(specId) {
  const data = await getSpecTree(specId);
  const references = await loadSpecReferences(specId);
  specs.set(specId, { ...specs.get(specId), ...data, references });
}

// Re-fetch every loaded spec. Needed after a remove-from-project, which marks
// other specs' references broken server-side; their trees must be re-read.
async function reloadAllSpecs() {
  await Promise.all([...specs.keys()].map((id) => reloadSpec(id)));
}

// ── TOC builder ─────────────────────────────────────────────────────────────

function makeNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function loadedTocEntries() {
  return [...specs.values()]
    .sort((a, b) => a.tree.section.localeCompare(b.tree.section))
    .map((spec) => ({ section: spec.tree.section, title: spec.tree.title }));
}

function loadedSectionSet() {
  return new Set([...specs.values()].map((spec) => spec.tree.section));
}

function tocSpecSource(spec) {
  return spec.source === 'client' ? spec.clientName : 'Company Master';
}

function normalizeQuery(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sortedTocLibrarySpecs(specsToSort = tocLibrarySpecs) {
  return [...specsToSort].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'client' ? -1 : 1;
    return compareTocSections(a, b);
  });
}

function tocSectionSortParts(section) {
  return section
    .split(/[ .]+/)
    .filter(Boolean)
    .map((part) => Number(part));
}

function compareTocSections(a, b) {
  const aParts = tocSectionSortParts(a.section);
  const bParts = tocSectionSortParts(b.section);
  const max = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < max; index += 1) {
    const aPart = aParts[index] ?? -1;
    const bPart = bParts[index] ?? -1;
    if (aPart !== bPart) return aPart - bPart;
  }
  return a.section.localeCompare(b.section) || (a.title ?? '').localeCompare(b.title ?? '');
}

function sortedTocSections(sections = tocSections) {
  return [...sections].sort(compareTocSections);
}

function tocDivision(section) {
  return section.match(/^\d{2}/)?.[0] ?? '??';
}

function groupedTocSections() {
  const groups = new Map();
  sortedTocSections().forEach((entry, index) => {
    const division = tocDivision(entry.section);
    if (!groups.has(division)) groups.set(division, []);
    groups.get(division).push({ entry, index });
  });
  return [...groups.entries()];
}

function updateTocHint() {
  const hint = document.getElementById('toc-hint');
  if (!hint) return;
  const dirty = hint.dataset.dirty === 'true';
  hint.textContent = activeProjectId
    ? `${activeProjectName()} · ${tocSections.length} required section${tocSections.length === 1 ? '' : 's'}${dirty ? ' - unsaved' : ''}`
    : 'project unavailable';
}

function setTocDirty(isDirty) {
  const hint = document.getElementById('toc-hint');
  if (hint) hint.dataset.dirty = isDirty ? 'true' : 'false';
  updateTocHint();
}

function renderTocBuilder() {
  const list = document.getElementById('toc-list');
  if (!list) return;
  list.replaceChildren();
  if (tocSections.length === 0) {
    list.appendChild(makeNode('li', 'toc-empty', 'No required sections yet.'));
    updateTocHint();
    return;
  }
  for (const [division, entries] of groupedTocSections()) {
    list.appendChild(renderTocDivisionGroup(division, entries));
  }
  updateTocHint();
}

function renderTocDivisionGroup(division, entries) {
  const item = makeNode('li', 'toc-division');
  const details = document.createElement('details');
  details.className = 'toc-division-details';
  details.open = !tocCollapsedDivisions.has(division);
  details.addEventListener('toggle', () => {
    if (details.open) tocCollapsedDivisions.delete(division);
    else tocCollapsedDivisions.add(division);
  });

  const summary = makeNode('summary', 'toc-division-summary');
  summary.appendChild(makeNode('span', 'toc-division-name', `Division ${division}`));
  summary.appendChild(
    makeNode(
      'span',
      'toc-division-count',
      `${entries.length} section${entries.length === 1 ? '' : 's'}`
    )
  );
  details.appendChild(summary);

  const rows = makeNode('ol', 'toc-division-list');
  for (const { entry, index } of entries) rows.appendChild(renderTocRow(entry, index));
  details.appendChild(rows);
  item.appendChild(details);
  return item;
}

function renderTocRow(entry, index) {
  const row = makeNode('li', 'toc-row');
  row.appendChild(makeNode('span', 'toc-position', String(index + 1).padStart(2, '0')));
  row.appendChild(makeNode('span', 'toc-section-code', displaySection(entry.section)));
  row.appendChild(makeNode('span', 'toc-title-text', entry.title || 'Untitled section'));
  row.appendChild(tocButton('REMOVE', () => removeTocEntry(entry.section)));
  return row;
}

function addLoadedSpecsToToc() {
  let added = 0;
  for (const entry of loadedTocEntries()) {
    if (addTocCandidate(candidateForSection(entry.section), { quiet: true })) {
      added += 1;
    }
  }
  if (added === 0) {
    toast('No loaded sections match the selected client/company library scope', 'warn');
    return 0;
  }
  toast(`${added} loaded section${added === 1 ? '' : 's'} added to TOC`);
  return added;
}

function tocButton(label, onClick, disabled = false) {
  const btn = makeNode('button', 'toc-row-btn', label);
  btn.type = 'button';
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function addTocCandidate(candidate, { quiet = false } = {}) {
  if (!candidate) {
    if (!quiet) toast('Spec is not available in the selected TOC library scope', 'warn');
    return false;
  }
  if (tocSections.some((entry) => entry.section === candidate.section)) {
    if (!quiet) toast(`Section ${candidate.section} is already in the TOC`, 'warn');
    return false;
  }
  tocSections = sortedTocSections([
    ...tocSections,
    { section: candidate.section, title: candidate.title },
  ]);
  setTocDirty(true);
  renderTocBuilder();
  return true;
}

function candidateForSection(section) {
  return tocLibrarySpecs.find((spec) => spec.section === section) ?? null;
}

function matchingTocSpecs() {
  const sectionValue = normalizeQuery(document.getElementById('toc-section-input')?.value ?? '');
  const titleValue = normalizeQuery(document.getElementById('toc-title-input')?.value ?? '');
  if (!sectionValue && !titleValue) return sortedTocLibrarySpecs().slice(0, 10);
  return sortedTocLibrarySpecs()
    .filter((spec) => {
      const section = spec.section.toLowerCase();
      const title = spec.title.toLowerCase();
      return (
        (!sectionValue || section.includes(sectionValue)) &&
        (!titleValue || title.includes(titleValue))
      );
    })
    .slice(0, 12);
}

function exactTocSpec() {
  const sectionValue = normalizeQuery(document.getElementById('toc-section-input')?.value ?? '');
  const titleValue = normalizeQuery(document.getElementById('toc-title-input')?.value ?? '');
  const matches = sortedTocLibrarySpecs().filter((spec) => {
    const sectionMatches = sectionValue && spec.section.toLowerCase() === sectionValue;
    const titleMatches = titleValue && spec.title.toLowerCase() === titleValue;
    if (sectionValue && titleValue) return sectionMatches && titleMatches;
    return sectionMatches || titleMatches;
  });
  return matches.length === 1 ? matches[0] : null;
}

function renderTocCandidates() {
  const wrap = document.getElementById('toc-candidates');
  if (!wrap) return;
  wrap.replaceChildren();
  if (tocLibrarySpecs.length === 0) {
    wrap.appendChild(
      makeNode('p', 'toc-candidate-empty', 'No company or selected-client specs available.')
    );
    return;
  }
  const candidates = matchingTocSpecs();
  if (candidates.length === 0) {
    wrap.appendChild(makeNode('p', 'toc-candidate-empty', 'No available library specs match.'));
    return;
  }
  for (const candidate of candidates) wrap.appendChild(renderTocCandidate(candidate));
}

function renderTocCandidate(candidate) {
  const btn = makeNode('button', 'toc-candidate');
  btn.type = 'button';
  btn.appendChild(makeNode('span', 'toc-candidate-section', displaySection(candidate.section)));
  btn.appendChild(makeNode('span', 'toc-candidate-title', candidate.title || 'Untitled section'));
  btn.appendChild(makeNode('span', 'toc-candidate-source', tocSpecSource(candidate)));
  btn.addEventListener('click', () => selectTocCandidate(candidate));
  return btn;
}

function selectTocCandidate(candidate) {
  document.getElementById('toc-section-input').value = candidate.section;
  document.getElementById('toc-title-input').value = candidate.title;
  renderTocCandidates();
}

function syncTocCounterpart(changedField) {
  const match = exactTocSpec();
  if (!match) return;
  if (changedField === 'section') {
    document.getElementById('toc-title-input').value = match.title;
  } else if (changedField === 'title') {
    document.getElementById('toc-section-input').value = match.section;
  }
}

function removeTocEntry(section) {
  tocSections = tocSections.filter((entry) => entry.section !== section);
  setTocDirty(true);
  renderTocBuilder();
}

async function refreshTocBuilder() {
  if (!activeProjectId) {
    renderTocBuilder();
    return;
  }
  if (!API_FEATURES.coordination) {
    renderTocBuilder();
    return;
  }
  try {
    const result = await getRequiredSections(activeProjectId);
    tocSections = sortedTocSections(
      (result ?? []).map((entry) => ({
        section: entry.section,
        title: entry.title,
      }))
    );
    setTocDirty(false);
    renderTocBuilder();
  } catch (err) {
    toast(`could not load TOC: ${err.message}`, 'warn');
  }
}

async function refreshTocClientScope() {
  const summary = document.getElementById('toc-source-summary');
  if (summary) summary.textContent = projectSourceLabel();
}

async function refreshTocLibrarySpecs() {
  const company = companyMaster();
  const selectedClients = projectClientLibraryIds
    .map((id) => libraries.find((lib) => lib.id === id))
    .filter(Boolean);
  const companySpecs = company ? await listLibrarySpecs(company.id) : [];
  const clientSpecGroups = await Promise.all(
    selectedClients.map(async (client) => ({
      client,
      specs: await listLibrarySpecs(client.id),
    }))
  );
  tocLibrarySpecs = [
    ...clientSpecGroups.flatMap(({ client, specs }) =>
      specs.map((spec) => ({
        ...spec,
        source: 'client',
        libraryId: client.id,
        clientName: client.name,
      }))
    ),
    ...companySpecs.map((spec) => ({
      ...spec,
      source: 'company',
      libraryId: company.id,
      clientName: null,
    })),
  ];
  renderTocCandidates();
}

async function syncProjectSourcesToTocScope() {
  if (!activeProjectId) return;
  if (!API_FEATURES.projectSources) return;
  const uniqueIds = projectSourceIds();
  if (uniqueIds.length === 0) return;
  try {
    const result = await setProjectSources(activeProjectId, uniqueIds);
    if (activeProject) activeProject = { ...activeProject, sources: result.sources ?? [] };
  } catch (err) {
    toast(`could not update project source libraries: ${err.message}`, 'warn');
  }
}

async function saveTocBuilder({ toastMessage = 'TOC saved' } = {}) {
  if (!activeProjectId) return;
  if (!API_FEATURES.coordination) {
    toast('TOC required-sections are not available in this API build', 'warn');
    return;
  }
  try {
    const payload = sortedTocSections().map((entry) => ({
      section: entry.section,
      ...(entry.title ? { title: entry.title } : {}),
    }));
    const result = await setRequiredSections(activeProjectId, payload);
    tocSections = sortedTocSections(
      (result ?? []).map((entry) => ({
        section: entry.section,
        title: entry.title,
      }))
    );
    setTocDirty(false);
    renderTocBuilder();
    await refreshDiagnostics();
    if (toastMessage) toast(toastMessage);
  } catch (err) {
    toast(`TOC save failed: ${err.message}`, 'err');
  }
}

function initTocBuilder() {
  const form = document.getElementById('toc-add-form');
  const section = document.getElementById('toc-section-input');
  const title = document.getElementById('toc-title-input');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (addTocCandidate(exactTocSpec())) {
      section.value = '';
      title.value = '';
      renderTocCandidates();
      section.focus();
    }
  });
  section?.addEventListener('input', () => {
    syncTocCounterpart('section');
    renderTocCandidates();
  });
  title?.addEventListener('input', () => {
    syncTocCounterpart('title');
    renderTocCandidates();
  });
  document.getElementById('toc-add-loaded')?.addEventListener('click', () => {
    addLoadedSpecsToToc();
  });
  document.getElementById('toc-clear')?.addEventListener('click', () => {
    tocSections = [];
    setTocDirty(true);
    renderTocBuilder();
  });
  document.getElementById('toc-save')?.addEventListener('click', () => void saveTocBuilder());
}

// ── Library manager ────────────────────────────────────────────────────────

function selectedLibrary() {
  return libraries.find((lib) => lib.id === selectedLibraryId) ?? null;
}

function companyMaster() {
  return libraries.find((lib) => lib.name === COMPANY_MASTER_NAME) ?? null;
}

function clientLibraries() {
  return libraries
    .filter((lib) => lib.tier === 'client')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapAddSourceLabel(library) {
  return library.tier === 'client' ? `Client: ${library.name}` : 'Company Masters';
}

function mapAddSourceLibraries() {
  return [companyMaster(), ...clientLibraries()].filter(Boolean);
}

async function chooseMapLibrarySource() {
  if (libraries.length === 0) await refreshLibraryView();
  const sources = mapAddSourceLibraries();
  if (sources.length === 0) {
    await openChoice({
      title: 'Add from library',
      body: 'No company or client libraries are available.',
      choices: [{ label: 'Close', value: null, kind: 'primary' }],
    });
    return null;
  }
  const selectedId = await openChoice({
    title: 'Add from library',
    body: 'Choose a master source.',
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      ...sources.map((library) => ({
        label: mapAddSourceLabel(library),
        value: library.id,
        kind: 'primary',
      })),
    ],
  });
  return sources.find((library) => library.id === selectedId) ?? null;
}

function renderMapLibrarySpecPick(spec) {
  const row = makeNode('span', 'modal-spec-row');
  row.appendChild(makeNode('span', 'modal-spec-section', spec.section));
  row.appendChild(makeNode('span', 'modal-spec-title', spec.title || 'Untitled section'));
  row.appendChild(makeNode('span', 'modal-spec-count', `${spec.nodeCount} nodes`));
  return row;
}

async function pickMapLibrarySpec(library) {
  const librarySpecs = sortedTocLibrarySpecs(await listLibrarySpecs(library.id));
  if (librarySpecs.length === 0) {
    await openChoice({
      title: mapAddSourceLabel(library),
      body: 'No specifications are loaded in this library.',
      choices: [{ label: 'Close', value: null, kind: 'primary' }],
    });
    return null;
  }
  return openPicker({
    title: mapAddSourceLabel(library),
    body: `${librarySpecs.length} specifications available.`,
    items: librarySpecs,
    itemText: (spec) => `${spec.section} ${spec.title}`,
    renderItem: renderMapLibrarySpecPick,
    searchPlaceholder: 'Section or title',
    emptyText: 'No specifications match.',
  });
}

async function setProjectSourcesForMapLibrary(library) {
  if (!activeProjectId) return;
  if (library.tier === 'client' && !projectClientLibraryIds.includes(library.id)) {
    projectClientLibraryIds = [...projectClientLibraryIds, library.id];
  }
  await syncProjectSourcesToTocScope();
  renderProjectControls();
}

async function addMapSpecFromLibrary() {
  if (!activeProjectId) {
    toast('Project is unavailable', 'warn');
    return;
  }
  const library = await chooseMapLibrarySource();
  if (!library) return;
  try {
    const spec = await pickMapLibrarySpec(library);
    if (!spec) return;
    if (loadedSectionSet().has(spec.section)) {
      toast(`Section ${spec.section} is already loaded on the project map`, 'warn');
      navigateToSection(spec.section);
      return;
    }
    await setProjectSourcesForMapLibrary(library);
    const result = await addSpecToProject(activeProjectId, spec.section);
    projectMembers.add(result.specId);
    await addSpec(result.specId);
    await reloadAllSpecs();
    await syncProjectSourcesToTocScope();
    renderBoard();
    await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    toast(
      `Section ${spec.section} loaded from ${result.source?.name || library.name} - TOC unchanged`
    );
    navigateToSection(spec.section);
  } catch (err) {
    toast(`could not add library spec: ${err.message}`, 'err');
  }
}

async function refreshLibraryView(preferredId = selectedLibraryId) {
  try {
    libraries = await listLibraries();
    selectedLibraryId = preferredId || companyMaster()?.id || libraries[0]?.id || null;
    if (selectedLibraryId && !libraries.some((lib) => lib.id === selectedLibraryId)) {
      selectedLibraryId = companyMaster()?.id || libraries[0]?.id || null;
    }
    await refreshSelectedLibrarySpecs();
    renderLibraryView();
  } catch (err) {
    toast(`could not load libraries: ${err.message}`, 'warn');
  }
}

async function ensureDemoClientLibraries() {
  if (!API_FEATURES.libraryWrites) return; // creating client libraries needs POST /libraries/clients
  try {
    const existing = await listLibraries();
    const existingNames = new Set(
      existing.filter((lib) => lib.tier === 'client').map((lib) => lib.name)
    );
    for (const name of DEMO_CLIENT_NAMES) {
      if (existingNames.has(name)) continue;
      try {
        await createClientLibrary(name);
      } catch (err) {
        if (err.status !== 409) throw err;
      }
    }
  } catch (err) {
    toast(`could not ensure demo clients: ${err.message}`, 'warn');
  }
}

async function refreshSelectedLibrarySpecs() {
  if (!selectedLibraryId) {
    selectedLibrarySpecs = [];
    return;
  }
  try {
    selectedLibrarySpecs = await listLibrarySpecs(selectedLibraryId);
  } catch (err) {
    selectedLibrarySpecs = [];
    toast(`could not load library specs: ${err.message}`, 'warn');
  }
}

function renderLibraryView() {
  renderLibrarySidebar();
  renderLibraryDetail();
}

function renderLibrarySidebar() {
  const company = companyMaster();
  const companyBtn = document.getElementById('company-master-btn');
  if (companyBtn) {
    companyBtn.classList.toggle('is-active', company?.id === selectedLibraryId);
    companyBtn.onclick = () => void selectLibrary(company?.id);
  }
  const list = document.getElementById('client-list');
  if (!list) return;
  list.replaceChildren();
  const clients = clientLibraries();
  if (clients.length === 0) {
    list.appendChild(makeNode('p', 'library-empty', 'No client masters yet.'));
    return;
  }
  for (const client of clients) {
    const btn = makeNode('button', 'client-item', client.name);
    btn.type = 'button';
    btn.classList.toggle('is-active', client.id === selectedLibraryId);
    btn.addEventListener('click', () => void selectLibrary(client.id));
    list.appendChild(btn);
  }
}

async function selectLibrary(libraryId) {
  if (!libraryId) return;
  selectedLibraryId = libraryId;
  await refreshSelectedLibrarySpecs();
  renderLibraryView();
}

function renderLibraryDetail() {
  const library = selectedLibrary();
  const kicker = document.getElementById('library-kicker');
  const title = document.getElementById('library-title');
  const hint = document.getElementById('library-hint');
  const rename = document.getElementById('library-rename');
  const add = document.getElementById('library-add-specs');
  if (kicker) kicker.textContent = library?.tier === 'client' ? 'CLIENT MASTER' : 'COMPANY MASTER';
  if (title) title.textContent = library?.name || 'No library selected';
  if (hint) {
    hint.textContent = `${selectedLibrarySpecs.length} available specification${selectedLibrarySpecs.length === 1 ? '' : 's'}`;
  }
  if (rename) rename.hidden = library?.tier !== 'client';
  if (add) add.disabled = !library;
  renderLibraryTree();
}

function renderLibraryTree() {
  const tree = document.getElementById('library-tree');
  if (!tree) return;
  tree.replaceChildren();
  if (!selectedLibraryId) {
    tree.appendChild(makeNode('p', 'library-empty', 'Select a library.'));
    return;
  }
  if (selectedLibrarySpecs.length === 0) {
    tree.appendChild(makeNode('p', 'library-empty', 'No specifications in this library.'));
    return;
  }
  const divisions = new Map();
  for (const spec of selectedLibrarySpecs) {
    const key = spec.section.slice(0, 2) || '??';
    divisions.set(key, [...(divisions.get(key) ?? []), spec]);
  }
  for (const [division, specsForDivision] of [...divisions.entries()].sort()) {
    const group = makeNode('section', 'library-division');
    group.appendChild(
      makeNode('h3', 'library-division-title', `Division ${division} (${specsForDivision.length})`)
    );
    const list = makeNode('ul', 'library-spec-list');
    for (const spec of specsForDivision) list.appendChild(renderLibrarySpecRow(spec));
    group.appendChild(list);
    tree.appendChild(group);
  }
}

function renderLibrarySpecRow(spec) {
  const row = makeNode('li', 'library-spec-row');
  row.appendChild(makeNode('span', 'library-spec-section', spec.section));
  row.appendChild(makeNode('span', 'library-spec-title', spec.title || 'Untitled section'));
  row.appendChild(makeNode('span', 'library-spec-count', `${spec.nodeCount} nodes`));
  const remove = makeNode('button', 'library-remove', 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => void removeSpecFromLibrary(spec));
  row.appendChild(remove);
  return row;
}

async function addClientLibrary(name) {
  if (!API_FEATURES.libraryWrites) {
    toast('Creating client libraries is not available in this API build', 'warn');
    return;
  }
  const clean = name.trim();
  if (!clean) return;
  try {
    const library = await createClientLibrary(clean);
    await refreshLibraryView(library.id);
    renderProjectControls();
    await refreshTocClientScope();
    await refreshTocLibrarySpecs();
    await syncProjectSourcesToTocScope();
    toast(`Client ${library.name} added`);
  } catch (err) {
    toast(`client add failed: ${err.message}`, 'err');
  }
}

async function renameSelectedClient() {
  if (!API_FEATURES.libraryWrites) {
    toast('Renaming libraries is not available in this API build', 'warn');
    return;
  }
  const library = selectedLibrary();
  if (!library || library.tier !== 'client') return;
  const name = await modalText({
    title: 'Rename client',
    label: 'Client name',
    value: library.name,
    confirmLabel: 'Rename',
  });
  if (!name || name === library.name) return;
  try {
    const renamed = await renameLibrary(library.id, name);
    await refreshLibraryView(renamed.id);
    renderProjectControls();
    await refreshTocClientScope();
    await refreshTocLibrarySpecs();
    await syncProjectSourcesToTocScope();
    toast(`Client renamed to ${renamed.name}`);
  } catch (err) {
    toast(`rename failed: ${err.message}`, 'err');
  }
}

async function removeSpecFromLibrary(spec) {
  if (!API_FEATURES.specDelete) {
    toast('Deleting library specs is not available in this API build', 'warn');
    return;
  }
  const ok = await openConfirm({
    title: 'Remove library specification',
    body: [
      {
        text: `Remove Section ${spec.section} from ${selectedLibrary()?.name || 'this library'}?`,
        kind: 'strong',
      },
      { text: 'This deletes the library copy. Project TOCs are unchanged.', kind: 'warn' },
    ],
    confirmLabel: 'Remove spec',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteSpec(spec.specId);
    specs.delete(spec.specId);
    projectMembers.delete(spec.specId);
    await refreshSelectedLibrarySpecs();
    renderLibraryView();
    await refreshTocLibrarySpecs();
    renderBoard();
    await refreshCoordination();
    await refreshOpenComments();
    toast(`Section ${spec.section} removed from library`);
  } catch (err) {
    toast(`remove failed: ${err.message}`, 'err');
  }
}

function addSpecsToSelectedLibrary() {
  const context = selectedLibraryDropContext();
  if (!context) return;
  const input = document.getElementById('file-input');
  input.dataset.context = JSON.stringify(context);
  input.click();
}

function selectedLibraryDropContext() {
  const library = selectedLibrary();
  if (!library) return null;
  return {
    destination: 'library',
    libraryId: library.id,
    library: library.tier === 'client' ? 'client' : 'company',
    libraryName: library.name,
    client: library.tier === 'client' ? library.name : undefined,
  };
}

async function restoreProjectSpecs(project = activeProject) {
  if (!activeProjectId || !project) return;
  try {
    const toc = project.toc ?? [];
    const settled = await Promise.allSettled(toc.map((entry) => addSpec(entry.specId)));
    const restored = settled.filter((r) => r.status === 'fulfilled').length;
    const failed = settled.length - restored;
    for (const entry of toc) projectMembers.add(entry.specId);
    if (restored > 0) {
      toast(`${restored} ${activeProjectName()} section${restored === 1 ? '' : 's'} restored`);
    }
    if (failed > 0) {
      toast(`${failed} project section${failed === 1 ? '' : 's'} failed to restore`, 'warn');
    }
  } catch (err) {
    toast(`could not restore project specs: ${err.message}`, 'warn');
  }
}

function modalText({ title, label, value = '', confirmLabel }) {
  const field = makeNode('label', 'modal-field');
  field.appendChild(makeNode('span', null, label));
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  field.appendChild(input);
  return openChoice({
    title,
    body: [field],
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: confirmLabel, value: 'ok', kind: 'primary' },
    ],
  }).then((choice) => (choice ? input.value.trim() : null));
}

function initLibraryManager() {
  const form = document.getElementById('client-add-form');
  const input = document.getElementById('client-name-input');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void addClientLibrary(input.value);
    input.value = '';
  });
  document.getElementById('library-rename')?.addEventListener('click', () => {
    void renameSelectedClient();
  });
  document
    .getElementById('library-add-specs')
    ?.addEventListener('click', addSpecsToSelectedLibrary);
}

// ── Edit mutations (wired into every sheet via sheetCtx) ─────────────────────

function preview(text, max = 140) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Every node id in a paragraph's subtree (itself + all descendants). Deleting a
// paragraph cascades to its children, so the delete warning must cover them.
function subtreeNodeIds(node) {
  const ids = [node.id];
  for (const child of node.children ?? []) ids.push(...subtreeNodeIds(child));
  return ids;
}

// All references the cascade would remove when a paragraph is deleted — those
// on the node AND on any descendant paragraph.
function refsInSubtree(spec, node) {
  const ids = new Set(subtreeNodeIds(node));
  return spec.references.filter((r) => ids.has(r.sourceParagraphId));
}

// Every loaded spec id for the removed citations' sections. The live board is
// the source of truth ("is this section in the project right now"), and a
// section can be loaded from two sources at once — so collect ALL ids, not one.
// Excludes ownSpecId so a paragraph citing its OWN section can never delete the
// spec being edited.
function removableTargetIds(removedRefs, ownSpecId) {
  const ids = new Set();
  for (const ref of removedRefs) {
    for (const id of loadedSections().get(ref.targetSection) ?? []) {
      if (id !== ownSpecId) ids.add(id);
    }
  }
  return [...ids];
}

// Reversible soft removal (#251) — toggle a body paragraph's vanish flag. The
// server keeps the row, its subtree, and any references intact; the node simply
// re-renders greyed with a VANISH tag (removed) or normally (restored), and the
// Restore affordance flips. Structural/note nodes are rejected 422 — surface
// that as a clear warning rather than a generic failure.
async function onToggleParagraphRemoval(spec, node, removed) {
  if (!API_FEATURES.paragraphRemoval) {
    toast('Paragraph removal is not available in this API build', 'warn');
    return;
  }
  const specId = spec.tree.id;
  try {
    await setParagraphRemoved(specId, node.id, removed);
    await reloadSpec(specId);
    renderBoard();
    await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    toast(removed ? 'Paragraph removed — hidden from owner renders' : 'Paragraph restored');
  } catch (err) {
    if (err.status === 422) {
      toast('Only body paragraphs can be removed — this node type cannot', 'warn');
      return;
    }
    toast(`${removed ? 'remove' : 'restore'} failed: ${err.message}`, 'err');
  }
}

// Feature A — delete a paragraph (and, by cascade, any reference it contains).
async function onDeleteParagraph(spec, node) {
  if (!API_FEATURES.paragraphDelete) {
    toast('Deleting paragraphs is not available in this API build', 'warn');
    return;
  }
  const specId = spec.tree.id;
  // Deleting a paragraph cascades to its whole subtree on the server, so count
  // references and nested items across the subtree — not just this node.
  const contained = refsInSubtree(spec, node);
  const nestedCount = subtreeNodeIds(node).length - 1;
  const body = [
    { text: 'Delete this paragraph?', kind: 'strong' },
    { text: `“${preview(node.text)}”`, kind: 'mono' },
  ];
  if (nestedCount > 0) {
    body.push({
      text: `This also deletes ${nestedCount} nested item${nestedCount === 1 ? '' : 's'} beneath it.`,
      kind: 'warn',
    });
  }
  if (contained.length > 0) {
    const list = [...new Set(contained.map((r) => r.targetSection || r.referenceText))].join(', ');
    body.push({
      text: `It contains ${contained.length} cross-reference${contained.length === 1 ? '' : 's'} (${list}) — deleting the paragraph removes ${contained.length === 1 ? 'it' : 'them'} too.`,
      kind: 'warn',
    });
  }
  const ok = await openConfirm({
    title: 'Delete paragraph',
    body,
    confirmLabel: 'Delete paragraph',
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteParagraph(specId, node.id);
    await reloadSpec(specId);
    renderBoard();
    await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    toast(
      contained.length > 0
        ? `Paragraph deleted — ${contained.length} reference${contained.length === 1 ? '' : 's'} removed`
        : 'Paragraph deleted'
    );
  } catch (err) {
    toast(`delete failed: ${err.message}`, 'err');
  }
}

// Feature B — save a paragraph edit; if it removed citations, ask what to do.
async function onSaveParagraphEdit({ spec, node, newText, removedRefs }) {
  const specId = spec.tree.id;
  if (removedRefs.length === 0) {
    return commitTextEdit(specId, node.id, newText, []);
  }
  const choice = await openChoice({
    title: 'This edit removes a cross-reference',
    body: buildRemovalBody(removedRefs, specId),
    choices: removalChoices(removedRefs, specId),
  });
  if (choice === 'cancel' || choice === null) return 'cancelled';
  return commitTextEdit(specId, node.id, newText, removedRefs, choice === 'ref-spec');
}

function removalChoices(removedRefs, ownSpecId) {
  const choices = [
    { label: 'Cancel', value: 'cancel', kind: 'ghost' },
    {
      label: removedRefs.length === 1 ? 'Delete the reference' : 'Delete the references',
      value: 'ref',
      kind: 'primary',
    },
  ];
  if (removableTargetIds(removedRefs, ownSpecId).length > 0) {
    choices.push({
      label: 'Delete reference + remove spec from project',
      value: 'ref-spec',
      kind: 'danger',
    });
  }
  return choices;
}

function buildRemovalBody(removedRefs, ownSpecId) {
  const sections = [...new Set(removedRefs.map((r) => r.targetSection || r.referenceText))];
  const body = [
    {
      text: `Your edit removes ${removedRefs.length === 1 ? 'a citation' : 'citations'} to ${sections.join(', ')}.`,
      kind: 'strong',
    },
  ];
  if (removableTargetIds(removedRefs, ownSpecId).length > 0) {
    body.push({
      text: 'Removing the spec from the project drops its sheet and asks the server to mark every other section that still cites it as broken.',
      kind: 'muted',
    });
  } else {
    body.push({
      text: 'The cited section is not loaded on the board, so only the citation itself can be removed.',
      kind: 'muted',
    });
  }
  return body;
}

async function commitTextEdit(specId, nodeId, newText, removedRefs, alsoRemoveSpec = false) {
  try {
    await updateParagraph(specId, nodeId, newText);
    // The paragraph PATCH re-derives this spec's references server-side, so the
    // edited-out citations drop automatically — no explicit per-reference delete
    // (DELETE /specs/:id/references/:refId isn't part of main's API; refs are
    // derived from text, not independently deletable).
    if (alsoRemoveSpec) await removeTargetSpecs(removedRefs, specId);
    await reloadAllSpecs();
    renderBoard();
    const brokenCount = await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    announceEdit(removedRefs, alsoRemoveSpec, brokenCount);
    return 'committed';
  } catch (err) {
    // updateParagraph commits before the per-reference deletes, so a later
    // failure can leave the server partially mutated. Resync the board to the
    // real server state rather than retrying on top of half-applied changes
    // (which would re-delete already-removed references).
    await reloadAllSpecs();
    renderBoard();
    await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    toast(`save failed: ${err.message}`, 'err');
    return 'cancelled';
  }
}

// Removes each loaded target spec from the project (broken-ref cascade), then
// deletes it outright so its sheet leaves the board. Never touches the spec
// being edited (removableTargetIds excludes ownSpecId).
async function removeTargetSpecs(removedRefs, ownSpecId) {
  const targetIds = removableTargetIds(removedRefs, ownSpecId);
  for (const targetId of targetIds) {
    if (activeProjectId) {
      try {
        await removeSpecFromProject(activeProjectId, targetId);
      } catch (err) {
        console.warn(`SpecR: could not remove ${targetId} from project`, err);
      }
    }
    projectMembers.delete(targetId);
    // It has left the project, so drop its sheet from the board regardless of
    // what happens next.
    specs.delete(targetId);
    // Best-effort hard delete from the library too — may 409 if the spec is
    // still pinned to another project; that's fine, the sheet is already gone.
    // DELETE /specs/:id isn't on main yet (gated), so skip the library purge.
    if (API_FEATURES.specDelete) {
      try {
        await deleteSpec(targetId);
      } catch (err) {
        console.warn(
          `SpecR: ${targetId} left the project but was not deleted from the library`,
          err
        );
      }
    }
  }
}

function announceEdit(removedRefs, alsoRemoveSpec, brokenCount) {
  if (removedRefs.length === 0) {
    toast('Paragraph updated');
    return;
  }
  if (alsoRemoveSpec) {
    const secs = [...new Set(removedRefs.map((r) => r.targetSection).filter(Boolean))];
    const n = brokenCount ?? 0;
    toast(
      `Removed ${secs.join(', ')} from the project — ${n} reference${n === 1 ? '' : 's'} now broken (server-computed)`,
      n > 0 ? 'warn' : 'info'
    );
    return;
  }
  toast(
    `Paragraph updated — ${removedRefs.length} reference${removedRefs.length === 1 ? '' : 's'} removed`
  );
}

async function onRemoveSpecFromProject(spec) {
  const specId = spec.tree.id;
  const ok = await openConfirm({
    title: 'Remove section from project',
    body: [
      { text: `Remove Section ${spec.tree.section} from the project map?`, kind: 'strong' },
      {
        text: 'The Table of Contents is unchanged. Remove TOC entries from the TOC page intentionally.',
        kind: 'muted',
      },
    ],
    confirmLabel: 'Remove from project',
    danger: true,
  });
  if (!ok) return;
  try {
    const removedFromProject = activeProjectId
      ? await removeSpecFromProjectIfPresent(specId)
      : false;
    projectMembers.delete(specId);
    specs.delete(specId);
    await reloadAllSpecs();
    renderBoard();
    const brokenCount = await refreshBrokenCount();
    await refreshCoordination();
    await refreshOpenComments();
    await refreshSubmittalRegister();
    const action = removedFromProject ? 'removed from project' : 'removed from map';
    toast(
      `Section ${spec.tree.section} ${action} — TOC unchanged${brokenCount ? `, ${brokenCount} broken refs` : ''}`,
      brokenCount ? 'warn' : 'info'
    );
  } catch (err) {
    toast(`remove failed: ${err.message}`, 'err');
  }
}

async function removeSpecFromProjectIfPresent(specId) {
  try {
    await removeSpecFromProject(activeProjectId, specId);
    return true;
  } catch (err) {
    if (err.message === 'spec not in project') return false;
    throw err;
  }
}

async function addSpecsFromTocToProject() {
  if (!activeProjectId) return;
  const loaded = loadedSectionSet();
  const missing = sortedTocSections().filter((entry) => !loaded.has(entry.section));
  if (missing.length === 0) {
    toast('All TOC sections are already loaded on the project map');
    return;
  }
  let added = 0;
  let failed = 0;
  for (const entry of missing) {
    try {
      const result = await addSpecToProject(activeProjectId, entry.section);
      projectMembers.add(result.specId);
      await addSpec(result.specId);
      added += 1;
    } catch (err) {
      failed += 1;
      console.warn(`SpecR: could not add TOC section ${entry.section} to project`, err);
    }
  }
  await reloadAllSpecs();
  renderBoard();
  await refreshBrokenCount();
  await refreshCoordination();
  await refreshOpenComments();
  await refreshSubmittalRegister();
  if (added > 0) toast(`${added} TOC section${added === 1 ? '' : 's'} loaded on the map`);
  if (failed > 0)
    toast(`${failed} TOC section${failed === 1 ? '' : 's'} could not be loaded`, 'warn');
}

async function updateLoadedSpecsToToc() {
  const added = addLoadedSpecsToToc();
  if (added === 0) {
    await refreshDiagnostics();
    return;
  }
  await saveTocBuilder({
    toastMessage: `${added} loaded section${added === 1 ? '' : 's'} synced to TOC and diagnostics`,
  });
}

function onAddSpecToToc(spec) {
  const candidate = candidateForSection(spec.tree.section);
  if (addTocCandidate(candidate)) {
    toast(`Section ${spec.tree.section} added to TOC`);
  }
}

// section -> specIds[]. The (section, source) DB constraint means the same
// section can be loaded from two sources (.sec + .docx); never collapse them.
function loadedSections() {
  const sections = new Map();
  for (const spec of specs.values()) {
    const ids = sections.get(spec.tree.section) || [];
    sections.set(spec.tree.section, [...ids, spec.tree.id]);
  }
  return sections;
}

// Section-number link status, resolved client-side against the live board —
// upload order doesn't matter: links heal as their targets arrive.
function statusFor(section) {
  const loaded = loadedSections();
  if (loaded.has(section)) return 'loaded';
  for (const spec of specs.values()) {
    for (const ref of spec.references) {
      if (ref.targetSection === section) {
        return ref.targetSpecId ? 'library' : 'unresolved';
      }
    }
  }
  return null;
}

function sheetForSection(section) {
  const specIds = loadedSections().get(section);
  if (!specIds || specIds.length === 0) return null;
  // Same-section duplicates sit adjacent on the section-sorted board; pick the
  // first sheet in DOM order so navigation is deterministic.
  return (
    specIds.map((id) => document.getElementById(`sheet-${id}`)).find((node) => node !== null) ??
    null
  );
}

function flashSheet(sheet, { scroll }) {
  if (scroll) sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sheet.classList.remove('is-flash');
  void sheet.offsetWidth; // restart the flash animation so flashes never pile up
  sheet.classList.add('is-flash');
  sheet.addEventListener('animationend', () => sheet.classList.remove('is-flash'), { once: true });
}

function navigateToSection(section) {
  const sheet = sheetForSection(section);
  if (!sheet) return;
  if (currentView !== 'map') showView('map');
  flashSheet(sheet, { scroll: true });
}

// Chat-driven focus: highlight the section(s) an answer resolves to in the
// currently-active tab. Never switches views — a toast is the fallback when the
// active tab can't show them (spec: 2026-07-01-chat-driven-focus).
function focusToast(count) {
  const s = count === 1 ? '' : 's';
  toast(`${count} section${s} found — open Project Spec Map to view`, 'info');
}

function applyFocusOnMap(sections) {
  const sheets = sections.map(sheetForSection).filter((node) => node !== null);
  if (sheets.length === 0) {
    const s = sections.length === 1 ? '' : 's';
    toast(`${sections.length} section${s} found — none are loaded in this project map`, 'info');
    return;
  }
  sheets.forEach((sheet, i) => flashSheet(sheet, { scroll: i === 0 }));
}

function applyFocusOnReport(anchors) {
  // Prefer an anchor whose spec is already loaded so the pane stays in project
  // context; the paragraphId is paired with that spec, so the exact paragraph
  // resolves. Fall back to the first anchor otherwise.
  const anchor = anchors.find((a) => a.specId && specs.has(a.specId)) ?? anchors[0];
  void audit.showAnchor(anchor);
  if (anchors.length > 1) {
    toast(`${anchors.length} locations found — showing the first`, 'info');
  }
}

function applyFocusOnEditor(sections) {
  const loadedSet = loadedSections();
  const loaded = sections.filter((section) => loadedSet.has(section));
  if (loaded.length === 0) {
    const s = sections.length === 1 ? '' : 's';
    toast(`${sections.length} section${s} found — none are loaded in this project`, 'info');
    return;
  }
  editorPanel.open(loaded[0]);
  if (loaded.length > 1) toast(`${loaded.length} sections found — showing the first`, 'info');
}

function applyFocus(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return;
  const clean = anchors.filter((a) => a && typeof a.section === 'string' && a.section !== '');
  if (clean.length === 0) return;
  const sections = [...new Set(clean.map((a) => a.section))];
  // Map highlights whole sheets by section; Report scrolls to the exact
  // paragraph, so it needs the full anchors (specId + paragraphId), not sections.
  if (currentView === 'map') return applyFocusOnMap(sections);
  if (currentView === 'report' && audit) return applyFocusOnReport(clean);
  if (currentView === 'editor' && editorPanel) return applyFocusOnEditor(sections);
  focusToast(sections.length);
}

// A human-readable summary of what's loaded, handed to the Compose agent as a
// scope hint. The agent still discovers real UUIDs via grounded tools; this only
// steers it toward the sections/projects the user actually has open.
function composeScopeLabel() {
  const sections = [...loadedSections().keys()].sort().map(displaySection);
  const loaded = sections.length > 0 ? sections.join(', ') : 'no sections loaded yet';
  return `active project "${activeProjectName()}"; loaded sections: ${loaded}`;
}

// A Compose citation click opens its source in the Report/audit view — the exact
// paragraph when the anchor carries one, reusing the same machinery as the chat
// focus channel and the coordination audit.
function onComposeCite(anchor) {
  if (!anchor || typeof anchor.section !== 'string') return;
  showView('report');
  if (audit) void audit.showAnchor(anchor);
}

function onLibraryRef(section) {
  toast(`Section ${section} is in the SpecR library — drop its file to load it`, 'warn');
}

// ── Editor + Constellation wiring (#369) ────────────────────────────────────

// Resolves `section` from the project's source libraries into the project and
// loads its sheet. Errors propagate with .status so callers can phrase them
// (404 not in masters, 409 already in project).
async function addSectionFromMasters(section) {
  if (!activeProjectId) throw new Error('no active project');
  const result = await addSpecToProject(activeProjectId, section);
  projectMembers.add(result.specId);
  await addSpec(result.specId);
  // The arrival can heal other sections' broken refs — refetch everyone's
  // references before the caller re-renders from the shared specs map.
  await reloadAllSpecs();
  renderBoard();
  await refreshBrokenCount();
  await refreshCoordination();
  await refreshOpenComments();
  toast(`Section ${displaySection(section)} added from source libraries`);
}

// Removes every loaded copy of `section` from the project — the editor
// review-queue's CONFIRM REMOVAL. The server recomputes broken inbound
// references; the refreshed count lands in the masthead and the toast.
async function removeSectionFromProject(section) {
  const specIds = loadedSections().get(section) ?? [];
  for (const specId of specIds) {
    if (activeProjectId) await removeSpecFromProjectIfPresent(specId);
    projectMembers.delete(specId);
    specs.delete(specId);
  }
  await reloadAllSpecs();
  renderBoard();
  const brokenCount = await refreshBrokenCount();
  await refreshCoordination();
  await refreshOpenComments();
  await refreshSubmittalRegister();
  toast(
    `Section ${displaySection(section)} removed from project${brokenCount ? ` — ${brokenCount} broken refs` : ''}`,
    brokenCount ? 'warn' : 'info'
  );
}

// A section available in the project's source libraries (company + selected
// clients) — powers "ADD FROM MASTERS" in both new views.
function findLibrarySpec(section) {
  return tocLibrarySpecs.find((spec) => spec.section === section) ?? null;
}

const sheetCtx = {
  displaySection,
  statusFor,
  onNavigate: navigateToSection,
  onLibraryRef,
  onWalkMiss: (section, foundInText) =>
    toast(
      foundInText
        ? `${section} appears in this spec but isn't linkable — details in console (F12)`
        : `${section} was extracted at ingest but its text isn't in the body verbatim`,
      'warn'
    ),
  // Per-paragraph affordances (tree.js renders one button per wired callback):
  //   ✎ edit    — always on (text editing has no capability flag)
  //   ⊘/↩ remove — only when paragraphRemoval is served (#251, soft + reversible)
  //   ✕ delete   — only when paragraphDelete is served (Phase 4 hard delete)
  onSaveParagraphEdit,
  ...(API_FEATURES.paragraphRemoval ? { onToggleParagraphRemoval } : {}),
  ...(API_FEATURES.paragraphDelete ? { onDeleteParagraph } : {}),
  onRemoveSpecFromProject,
  onAddSpecToToc,
  toast,
};

function refreshWeb() {
  const model = buildWebModel(specs);
  renderWeb(webCanvas, model, {
    onNavigate: navigateToSection,
    displaySection,
  });
  const loaded = model.nodes.filter((n) => n.status === 'loaded').length;
  const ghosts = model.nodes.length - loaded;
  webHint.textContent =
    model.edges.length === 0
      ? 'arcs draw as sections cite one another'
      : `${model.edges.length} reference path${model.edges.length === 1 ? '' : 's'} · ` +
        `${loaded} loaded · ${ghosts} cited but not loaded`;
}

// Re-render every sheet so ref-link statuses pick up newly loaded sections.
function renderBoard() {
  emptyState.hidden = specs.size > 0;
  updateAddFabVisibility();
  for (const old of board.querySelectorAll('.spec-sheet')) old.remove();
  const ordered = [...specs.values()].sort((a, b) => a.tree.section.localeCompare(b.tree.section));
  for (const spec of ordered) {
    board.appendChild(renderSpecSheet(spec, sheetCtx));
  }
  refreshWeb();
  renderTocBuilder();
  // The editor and constellation read the same specs Map — keep them current.
  editorPanel?.onDataChanged();
  constellationPanel?.onDataChanged();
}

async function addSpec(specId, extras = {}) {
  const data = await getSpecTree(specId);
  const references = await loadSpecReferences(specId);
  specs.set(specId, { ...data, ...extras, references });
  renderBoard();
}

async function onSpecReady(result, context = { destination: 'project' }) {
  const isNew = !specs.has(result.specId);
  if (context.destination === 'library') {
    markLibraryOnly(result.specId);
    const library = context.library === 'client' ? context.client : 'Company Masters';
    await refreshLibraryView(context.libraryId || selectedLibraryId);
    await refreshTocClientScope();
    await refreshTocLibrarySpecs();
    toast(`Section ${result.section} added to ${library}`);
    return;
  }
  markProjectVisible(result.specId);
  await addSpec(result.specId, {
    warnings: result.warnings,
    capabilities: result.capabilities,
  });
  // Join the active project — re-adding a previously-removed section also heals
  // any references the server had marked broken, so reload + recount.
  await joinProject(result.specId);
  await reloadAllSpecs();
  renderBoard();
  await refreshBrokenCount();
  await refreshCoordination();
  await refreshOpenComments();
  await refreshSubmittalRegister();
  toast(
    isNew
      ? `Section ${result.section} loaded — ${result.nodeCount} nodes inferred`
      : `Section ${result.section} re-parsed and refreshed`
  );
  navigateToSection(result.section);
}

async function onMapAddSectionsClick({ chooseFiles, defaultContext }) {
  const action = await openChoice({
    title: 'Add section',
    body: 'Choose a project-map source.',
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Add from Library', value: 'library', kind: 'primary' },
      { label: 'Upload Spec', value: 'upload', kind: 'primary' },
    ],
  });
  if (action === 'library') {
    await addMapSpecFromLibrary();
  } else if (action === 'upload') {
    // Onboard a brand-new spec into the project's base source library
    // (Company Masters) first, then resolve a project copy from it — the same
    // model as "Add from Library". POST /projects/:id/specs resolves sections
    // only from a project's source libraries, so a standalone /parse would
    // orphan the spec and 422 on join. Without a company master, fall back to
    // the standalone parse (no source library to onboard into).
    const company = companyMaster();
    const uploadContext = company
      ? {
          destination: 'project',
          source: 'master',
          libraryId: company.id,
          libraryName: company.name,
        }
      : defaultContext;
    chooseFiles(uploadContext);
  }
}

function initMapActions() {
  document.getElementById('map-add-from-toc')?.addEventListener('click', () => {
    void addSpecsFromTocToProject();
  });
  document.getElementById('map-update-toc')?.addEventListener('click', () => {
    void updateLoadedSpecsToToc();
  });
}

async function boot() {
  document.getElementById('tb-date').textContent = new Date().toISOString().slice(0, 10);
  initNavigation();
  initProjectManager();
  initTocBuilder();
  initLibraryManager();
  initMapActions();
  audit = initAudit({
    findingsPane: document.getElementById('audit-findings'),
    specPane: document.getElementById('audit-spec-pane'),
    specTitleEl: document.getElementById('audit-spec-title'),
    specHintEl: document.getElementById('audit-spec-hint'),
    split: document.getElementById('audit-split'),
    divider: document.getElementById('audit-divider'),
    getLoadedSpec: (specId) => specs.get(specId),
    fetchSpec: async (specId) => {
      const data = await getSpecTree(specId);
      const references = await loadSpecReferences(specId);
      return { ...data, references };
    },
    resolveSection: (section) => loadedSections().get(section)?.[0],
    // Read-only sheet: no edit/remove/toc callbacks, and citations reflect to a
    // finding instead of jumping to the map.
    renderSheet: (spec, onRefNavigate) =>
      renderSpecSheet(spec, { displaySection, statusFor, onLibraryRef, onNavigate: onRefNavigate }),
    displaySection,
  });
  numberingPanel = initNumbering({ getLibraries: () => libraries, toast });
  initChat({ onFocus: applyFocus });
  composePanel = initCompose({
    getScopeLabel: composeScopeLabel,
    onCite: onComposeCite,
    displaySection,
  });
  editorPanel = initEditor({
    getSpecs: () => specs,
    displaySection,
    // Same edit affordances as the map board, but navigation stays in-editor
    // and the sheet header stays clean (no DELETE / ADD TO TOC buttons —
    // section membership is the rail's flag-queue job here).
    makeSheetCtx: (overrides) => ({
      displaySection,
      statusFor,
      onLibraryRef,
      onWalkMiss: sheetCtx.onWalkMiss,
      onSaveParagraphEdit,
      ...(API_FEATURES.paragraphRemoval ? { onToggleParagraphRemoval } : {}),
      toast,
      ...overrides,
    }),
    addSection: addSectionFromMasters,
    removeSection: removeSectionFromProject,
    isActive: () => currentView === 'editor',
    toast,
  });
  constellationPanel = initConstellation({
    getSpecs: () => specs,
    displaySection,
    isFlagged: (section) => editorPanel.isFlagged(section),
    findInMasters: findLibrarySpec,
    addSection: addSectionFromMasters,
    openInEditor: (section) => {
      showView('editor');
      editorPanel.open(section);
    },
    openCitation: (from, to) => {
      showView('editor');
      editorPanel.open(from, { walkTo: to });
    },
    isActive: () => currentView === 'constellation',
    toast,
  });

  const health = document.getElementById('health-dot');
  const healthCell = health.closest('.tb-cell');
  try {
    await checkHealth();
    health.textContent = '● ONLINE';
    healthCell.classList.add('is-up');
  } catch {
    health.textContent = '● DB DOWN';
    healthCell.classList.add('is-down');
    toast('API reachable but database is down — uploads will fail', 'err');
  }

  initDropzone({
    onSpecReady,
    onReject: (message) => toast(message, 'err'),
    getDropContext: () => (currentView === 'library' ? selectedLibraryDropContext() : null),
    onAddSectionsClick: onMapAddSectionsClick,
  });
  initRefPopover();

  await ensureDemoClientLibraries();
  await refreshLibraryView();
  await ensureActiveProject();
  await loadActiveProjectWorkspace();
}

void boot();
