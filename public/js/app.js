// SpecR Section Linkage Console — entry point and state.
//
// State is a Map of specId -> { tree, references, warnings?, capabilities? }.
// Every mutation rebuilds the reference web and re-resolves the link status
// of every sheet, so dropping a cited section "heals" links board-wide.

import { checkHealth, listSpecs, getSpecTree } from './api.js';
import { renderSpecSheet } from './tree.js';
import { buildWebModel, renderWeb } from './web.js';
import { initDropzone } from './dropzone.js';

const specs = new Map(); // specId -> { tree, references, warnings?, capabilities? }
const board = document.getElementById('spec-board');
const emptyState = document.getElementById('empty-state');
const webCanvas = document.getElementById('ref-web-canvas');
const webHint = document.getElementById('web-hint');

function toast(message, kind = 'info') {
  const rack = document.getElementById('toast-rack');
  const node = document.createElement('div');
  node.className = `toast${kind === 'warn' ? ' is-warn' : ''}${kind === 'err' ? ' is-err' : ''}`;
  node.textContent = message;
  rack.appendChild(node);
  setTimeout(() => node.remove(), 5200);
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

function navigateToSection(section) {
  const specIds = loadedSections().get(section);
  if (!specIds || specIds.length === 0) return;
  // Same-section duplicates sit adjacent on the section-sorted board; flash the
  // first sheet in DOM order so navigation is deterministic.
  const sheet = specIds
    .map((id) => document.getElementById(`sheet-${id}`))
    .find((node) => node !== null);
  if (!sheet) return;
  sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sheet.classList.remove('is-flash');
  // restart the flash animation, then drop the class so flashes never pile up
  void sheet.offsetWidth;
  sheet.classList.add('is-flash');
  sheet.addEventListener('animationend', () => sheet.classList.remove('is-flash'), {
    once: true,
  });
}

function onLibraryRef(section) {
  toast(`Section ${section} is in the SpecR library — drop its file to load it`, 'warn');
}

const sheetCtx = {
  statusFor,
  onNavigate: navigateToSection,
  onLibraryRef,
};

function refreshWeb() {
  const model = buildWebModel(specs);
  renderWeb(webCanvas, model, {
    onNavigate: navigateToSection,
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
  document.getElementById('add-fab').hidden = specs.size === 0;
  for (const old of board.querySelectorAll('.spec-sheet')) old.remove();
  const ordered = [...specs.values()].sort((a, b) =>
    a.tree.section.localeCompare(b.tree.section)
  );
  for (const spec of ordered) {
    board.appendChild(renderSpecSheet(spec, sheetCtx));
  }
  refreshWeb();
}

async function addSpec(specId, extras = {}) {
  const data = await getSpecTree(specId);
  specs.set(specId, { ...data, ...extras });
  renderBoard();
}

async function onSpecReady(result) {
  const isNew = !specs.has(result.specId);
  await addSpec(result.specId, {
    warnings: result.warnings,
    capabilities: result.capabilities,
  });
  toast(
    isNew
      ? `Section ${result.section} loaded — ${result.nodeCount} nodes inferred`
      : `Section ${result.section} re-parsed and refreshed`
  );
  navigateToSection(result.section);
}

async function boot() {
  document.getElementById('tb-date').textContent = new Date()
    .toISOString()
    .slice(0, 10);

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
  });

  // Pull anything already in the library from a previous session. Each spec
  // restores independently — one bad tree must not abort the rest.
  try {
    const existing = await listSpecs();
    const withContent = existing.filter((entry) => entry.nodeCount > 0);
    const settled = await Promise.allSettled(withContent.map((entry) => addSpec(entry.specId)));
    const restored = settled.filter((r) => r.status === 'fulfilled').length;
    const failed = settled.length - restored;
    if (restored > 0) {
      toast(`${restored} section${restored === 1 ? '' : 's'} restored from library`);
    }
    if (failed > 0) {
      toast(`${failed} section${failed === 1 ? '' : 's'} failed to restore from library`, 'warn');
    }
  } catch (err) {
    toast(`could not list library specs: ${err.message}`, 'warn');
  }

  renderBoard();
}

void boot();
