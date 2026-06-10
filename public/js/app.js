// SpecR Section Linkage Console — entry point and state.
//
// State is a Map of specId -> { tree, references, warnings?, capabilities? }.
// Every mutation rebuilds the reference web and re-resolves the link status
// of every sheet, so dropping a cited section "heals" links board-wide.

import {
  checkHealth,
  listSpecs,
  getSpecTree,
  deleteParagraph,
  updateParagraph,
  deleteReference,
  deleteSpec,
  createProject,
  getProject,
  addSpecToProject,
  removeSpecFromProject,
  getBrokenRefs,
} from './api.js';
import { renderSpecSheet } from './tree.js';
import { buildWebModel, renderWeb } from './web.js';
import { initDropzone } from './dropzone.js';
import { initRefPopover } from './popover.js';
import { openConfirm, openChoice } from './modal.js';

const specs = new Map(); // specId -> { tree, references, warnings?, capabilities? }
const PROJECT_KEY = 'specr-demo-project';
let demoProjectId = null; // the hidden project every loaded section belongs to
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

// ── Demo project ────────────────────────────────────────────────────────────
// The board has no visible "project", but every loaded section quietly joins
// one hidden project so the server's broken-reference cascade can span the
// whole board. The id is cached in localStorage and re-created if the DB resets.

const projectMembers = new Set(); // spec ids known to be in the demo project

async function ensureDemoProject() {
  const saved = localStorage.getItem(PROJECT_KEY);
  if (saved) {
    try {
      const project = await getProject(saved);
      demoProjectId = saved;
      for (const entry of project.toc ?? []) projectMembers.add(entry.specId);
      return;
    } catch {
      // stale id (database was reset) — fall through and make a fresh project
    }
  }
  try {
    const project = await createProject(
      'SpecR Demo Board',
      'Auto-managed membership for the linkage console demo'
    );
    demoProjectId = project.projectId;
    localStorage.setItem(PROJECT_KEY, demoProjectId);
  } catch (err) {
    demoProjectId = null;
    toast(`could not create demo project — broken-ref cascade disabled: ${err.message}`, 'warn');
  }
}

async function joinProject(specId) {
  if (!demoProjectId || projectMembers.has(specId)) return;
  try {
    await addSpecToProject(demoProjectId, specId);
    projectMembers.add(specId);
  } catch (err) {
    // 409 = already a member (treat as joined); anything else is notable.
    if (err.status === 409) projectMembers.add(specId);
    else console.warn(`SpecR: could not add ${specId} to demo project`, err);
  }
}

// Updates the masthead BROKEN REFS cell from the server's count. Returns it.
async function refreshBrokenCount() {
  const cell = document.getElementById('broken-cell');
  const out = document.getElementById('broken-count');
  if (!demoProjectId) return 0;
  try {
    const broken = await getBrokenRefs(demoProjectId);
    if (out) out.textContent = String(broken.length);
    if (cell) cell.classList.toggle('is-broken', broken.length > 0);
    return broken.length;
  } catch {
    return null;
  }
}

// ── State refresh ───────────────────────────────────────────────────────────

async function reloadSpec(specId) {
  const data = await getSpecTree(specId);
  specs.set(specId, { ...specs.get(specId), ...data });
}

// Re-fetch every loaded spec. Needed after a remove-from-project, which marks
// other specs' references broken server-side; their trees must be re-read.
async function reloadAllSpecs() {
  await Promise.all([...specs.keys()].map((id) => reloadSpec(id)));
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

// Feature A — delete a paragraph (and, by cascade, any reference it contains).
async function onDeleteParagraph(spec, node) {
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
    for (const ref of removedRefs) {
      await deleteReference(specId, ref.id);
    }
    if (alsoRemoveSpec) await removeTargetSpecs(removedRefs, specId);
    await reloadAllSpecs();
    renderBoard();
    const brokenCount = await refreshBrokenCount();
    announceEdit(removedRefs, alsoRemoveSpec, brokenCount);
    return 'committed';
  } catch (err) {
    toast(`save failed: ${err.message}`, 'err');
    return 'cancelled'; // keep the editor open so the user can retry
  }
}

// Removes each loaded target spec from the project (broken-ref cascade), then
// deletes it outright so its sheet leaves the board. Never touches the spec
// being edited (removableTargetIds excludes ownSpecId).
async function removeTargetSpecs(removedRefs, ownSpecId) {
  const targetIds = removableTargetIds(removedRefs, ownSpecId);
  for (const targetId of targetIds) {
    if (demoProjectId) {
      try {
        await removeSpecFromProject(demoProjectId, targetId);
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
    try {
      await deleteSpec(targetId);
    } catch (err) {
      console.warn(`SpecR: ${targetId} left the project but was not deleted from the library`, err);
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
  onWalkMiss: (section, foundInText) =>
    toast(
      foundInText
        ? `${section} appears in this spec but isn't linkable — details in console (F12)`
        : `${section} was extracted at ingest but its text isn't in the body verbatim`,
      'warn'
    ),
  // Edit affordances (presence of onDeleteParagraph flips on the per-paragraph
  // ✎/✕ controls inside tree.js).
  onDeleteParagraph,
  onSaveParagraphEdit,
  toast,
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
  // Join the demo project — re-adding a previously-removed section also heals
  // any references the server had marked broken, so reload + recount.
  await joinProject(result.specId);
  await reloadAllSpecs();
  renderBoard();
  await refreshBrokenCount();
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
  initRefPopover();

  await ensureDemoProject();

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
    // Every restored section joins the demo project so the cascade spans them.
    // Sequential, not parallel: addSpecToProject derives its position from
    // MAX(position)+1, so concurrent joins would race on the
    // (project_id, position) unique key and bounce with a 409.
    for (const id of specs.keys()) {
      await joinProject(id);
    }
  } catch (err) {
    toast(`could not list library specs: ${err.message}`, 'warn');
  }

  renderBoard();
  await refreshBrokenCount();
}

void boot();
