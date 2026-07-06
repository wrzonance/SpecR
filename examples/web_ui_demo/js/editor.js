// Editor view: full-page document editing for one project section at a time.
// Left rail = project TOC grouped by MasterFormat division (add sections from
// masters, flag-for-removal review queue); center = the live spec sheet
// (tree.js renders it with the same edit affordances as the map); right rail =
// section inspector (outbound CITES / inbound CITED BY, editability tallies).
// All text reaches the DOM via textContent — spec content is untrusted.

import { renderSpecSheet, locateLink, expandAncestors } from './tree.js';
import { divisionOf, divisionName } from './divisions.js';
import { applyRestructureOps, tryRestructure } from './restructure.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ctx contract (wired in app.js):
//   getSpecs()            -> Map<specId, { tree, references }>
//   displaySection(s)     -> section formatted per project setting
//   makeSheetCtx(over)    -> tree.js sheet ctx with editing wired; `over`
//                            replaces navigation so ref jumps stay in-editor
//   addSection(section)   -> async; resolves the section from project source
//                            libraries into the project (throws w/ .status)
//   removeSection(section)-> async; removes every loaded copy from the project
//   isActive()            -> true when the editor view is visible
//   toast(msg, kind)
export function initEditor(ctx) {
  const rail = document.getElementById('editor-rail');
  const main = document.getElementById('editor-main');
  const inspector = document.getElementById('editor-inspector');

  let selectedSection = null;
  let walkTarget = null; // section to locate inside the sheet after render
  let focusNodeId = null; // paragraph to refocus after a restructure re-render
  let deferredRender = false; // a data refresh arrived mid-inline-edit — replay on blur
  const flagged = new Set(); // sections staged for removal (demo-local review queue)
  const collapsed = new Set(); // divisions the user closed in the rail
  // Structure ops per spec id — Tab/Shift+Tab moves and Enter-inserted
  // drafts — replayed over a clone of the server tree (restructure.js).
  // Local preview only: no restructure (#371) or creation (#372) endpoint
  // yet; node ids stay stable so text PATCHes compose with the overlay.
  const restructureOps = new Map();
  let restructureNoticeShown = false;
  let insertNoticeShown = false;
  let addValue = '';
  let addError = '';

  function entries() {
    const list = [];
    for (const spec of ctx.getSpecs().values()) {
      list.push({ section: spec.tree.section, title: spec.tree.title || 'Untitled Section', spec });
    }
    return list.sort((a, b) => a.section.localeCompare(b.section));
  }

  function specFor(section) {
    return entries().find((e) => e.section === section)?.spec ?? null;
  }

  function ensureSelection() {
    const all = entries();
    if (all.length === 0) {
      selectedSection = null;
      return;
    }
    if (!selectedSection || !all.some((e) => e.section === selectedSection)) {
      selectedSection = all[0].section;
    }
  }

  // ── left rail ─────────────────────────────────────────────────────────────

  function renderAddForm() {
    const wrap = el('div', 'ed-add');
    const row = el('div', 'ed-add-row');
    const input = el('input', 'ed-add-input');
    input.type = 'text';
    input.placeholder = '09 51 13';
    input.value = addValue;
    input.setAttribute('aria-label', 'Section number to add');
    input.addEventListener('input', () => {
      addValue = input.value;
      if (addError) {
        addError = '';
        const err = wrap.querySelector('.ed-add-err');
        if (err) err.remove();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submitAdd();
    });
    const btn = el('button', 'ed-add-btn', 'ADD');
    btn.type = 'button';
    btn.title = 'Add this section to the project from its source libraries';
    btn.addEventListener('click', () => void submitAdd());
    row.appendChild(input);
    row.appendChild(btn);
    wrap.appendChild(row);
    if (addError) wrap.appendChild(el('p', 'ed-add-err', addError));
    wrap.appendChild(el('p', 'ed-add-hint', 'resolves from the project source libraries'));
    return wrap;
  }

  async function submitAdd() {
    const value = addValue.replace(/\s+/g, ' ').trim();
    if (!/^\d{2} \d{2} \d{2}(?:\.\d{2}(?: \d{2})?)?$/.test(value)) {
      addError = 'Use the NN NN NN format — e.g. 09 51 13';
      renderRail();
      return;
    }
    if (entries().some((e) => e.section === value)) {
      addError = 'That section is already in this project';
      renderRail();
      return;
    }
    try {
      await ctx.addSection(value);
      addValue = '';
      addError = '';
      selectedSection = value;
      render();
    } catch (err) {
      addError =
        err.status === 404
          ? 'Not found in the project source libraries'
          : err.status === 409
            ? 'That section is already in this project'
            : `add failed: ${err.message}`;
      renderRail();
    }
  }

  function renderDivisionGroup(division, groupEntries) {
    const group = el('div', 'ed-div');
    const hasSelected = groupEntries.some((e) => e.section === selectedSection);
    const open = hasSelected || !collapsed.has(division);

    const bar = el('button', 'ed-div-bar');
    bar.type = 'button';
    bar.appendChild(el('span', 'ed-div-caret', open ? '▾' : '▸'));
    bar.appendChild(el('span', 'ed-div-code', `DIV ${division}`));
    bar.appendChild(el('span', 'ed-div-name', divisionName(division)));
    if (hasSelected) bar.appendChild(el('span', 'ed-div-open', 'OPEN'));
    bar.appendChild(el('span', 'ed-div-count', String(groupEntries.length)));
    bar.addEventListener('click', () => {
      if (hasSelected && open) return; // the open section pins its division open
      if (open) collapsed.add(division);
      else collapsed.delete(division);
      renderRail();
    });
    group.appendChild(bar);

    if (open) {
      const list = el('div', 'ed-div-sections');
      for (const entry of groupEntries) {
        const isSelected = entry.section === selectedSection;
        const isFlagged = flagged.has(entry.section);
        const row = el('button', 'ed-sec');
        row.type = 'button';
        if (isSelected) row.classList.add('is-selected');
        if (isFlagged) row.classList.add('is-flagged');
        row.appendChild(el('span', 'ed-sec-num', ctx.displaySection(entry.section)));
        row.appendChild(el('span', 'ed-sec-title', entry.title));
        if (isFlagged) row.appendChild(el('span', 'ed-sec-flag', 'FLAG'));
        row.addEventListener('click', () => openSection(entry.section));
        list.appendChild(row);
      }
      group.appendChild(list);
    }
    return group;
  }

  function renderFlaggedQueue() {
    const staged = [...flagged].sort();
    if (staged.length === 0) return null;
    const queue = el('div', 'ed-queue');
    const head = el('div', 'ed-queue-head');
    head.appendChild(el('span', null, 'FLAGGED FOR REMOVAL'));
    head.appendChild(el('span', null, String(staged.length)));
    queue.appendChild(head);
    for (const section of staged) {
      const entry = entries().find((e) => e.section === section);
      const item = el('div', 'ed-queue-item');
      const label = el('div', 'ed-queue-label');
      label.appendChild(el('span', 'ed-queue-num', ctx.displaySection(section)));
      label.appendChild(el('span', 'ed-queue-title', entry?.title ?? section));
      item.appendChild(label);
      const actions = el('div', 'ed-queue-actions');
      const confirm = el('button', 'ed-queue-confirm', 'CONFIRM REMOVAL');
      confirm.type = 'button';
      confirm.title = 'Remove this section from the project — inbound references will break';
      confirm.addEventListener('click', () => void confirmRemoval(section, confirm));
      const restore = el('button', 'ed-queue-restore', 'RESTORE');
      restore.type = 'button';
      restore.title = 'Clear the flag — the section stays in the project';
      restore.addEventListener('click', () => {
        flagged.delete(section);
        render();
      });
      actions.appendChild(confirm);
      actions.appendChild(restore);
      item.appendChild(actions);
      queue.appendChild(item);
    }
    return queue;
  }

  async function confirmRemoval(section, button) {
    button.disabled = true;
    try {
      await ctx.removeSection(section);
      flagged.delete(section);
      if (selectedSection === section) selectedSection = null;
      render();
    } catch (err) {
      button.disabled = false;
      ctx.toast(`remove failed: ${err.message}`, 'err');
    }
  }

  function renderRail() {
    rail.replaceChildren();
    const head = el('div', 'ed-rail-head');
    head.appendChild(el('span', 'ed-rail-title', 'PROJECT TOC'));
    head.appendChild(el('span', 'ed-rail-sub', 'BY DIVISION'));
    rail.appendChild(head);
    rail.appendChild(renderAddForm());

    const byDivision = new Map();
    for (const entry of entries()) {
      const division = divisionOf(entry.section);
      byDivision.set(division, [...(byDivision.get(division) ?? []), entry]);
    }
    if (byDivision.size === 0) {
      rail.appendChild(
        el('p', 'ed-rail-empty', 'No sections in this project yet — add one above or drop files on the Project Spec Map.')
      );
    }
    for (const division of [...byDivision.keys()].sort()) {
      rail.appendChild(renderDivisionGroup(division, byDivision.get(division)));
    }
    const queue = renderFlaggedQueue();
    if (queue) rail.appendChild(queue);
  }

  // ── center sheet ──────────────────────────────────────────────────────────

  // Locates a node in the (server-truth) tree so optimistic text edits made on
  // the preview overlay can be mirrored back before the PATCH round-trips.
  function findBaseNode(forest, nodeId) {
    for (const node of forest) {
      if (node.id === nodeId) return node;
      const hit = findBaseNode(node.children, nodeId);
      if (hit) return hit;
    }
    return null;
  }

  // Tab / Shift+Tab (and the article ⇥ demote). `pendingText` carries an
  // uncommitted inline edit — mirrored onto the base tree so the immediate
  // re-render doesn't flash the old text while the PATCH is in flight.
  function handleRestructure(spec, node, dir, pendingText) {
    const specId = spec.tree.id;
    const base = ctx.getSpecs().get(specId);
    if (!base) return;
    if (pendingText) {
      const baseNode = findBaseNode(base.tree.parts, node.id);
      if (baseNode) baseNode.text = pendingText;
    }
    const ops = restructureOps.get(specId) ?? [];
    const probe = tryRestructure(base.tree.parts, ops, node.id, dir);
    if (!probe.ok) {
      ctx.toast(probe.reason, 'warn');
      return;
    }
    restructureOps.set(specId, [...ops, { op: 'move', nodeId: node.id, dir }]);
    if (!restructureNoticeShown) {
      restructureNoticeShown = true;
      ctx.toast(
        'Renumbered — structure changes are a local preview until the API grows a restructure endpoint (#371)',
        'info'
      );
    }
    focusNodeId = node.id;
    render();
  }

  // Enter: a new empty sibling of the same CSI tier, caret ready. Drafts are
  // preview-only until the API can create paragraphs (#372).
  function handleInsertAfter(spec, node, pendingText) {
    const specId = spec.tree.id;
    const base = ctx.getSpecs().get(specId);
    if (!base) return;
    if (node.type === 'part') {
      ctx.toast(
        'CSI sections keep their three-part format — press Enter inside an article instead',
        'warn'
      );
      return;
    }
    if (pendingText && !node.meta?.localDraft) {
      const baseNode = findBaseNode(base.tree.parts, node.id);
      if (baseNode) baseNode.text = pendingText;
    }
    const ops = restructureOps.get(specId) ?? [];
    // crypto.randomUUID is secure-context-only — absent over plain-HTTP LAN
    // access (HOST=0.0.0.0, server.mjs); any demo-locally-unique id works.
    const draftId =
      typeof crypto.randomUUID === 'function'
        ? `local-${crypto.randomUUID()}`
        : `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    restructureOps.set(specId, [
      ...ops,
      { op: 'insert', afterId: node.id, nodeId: draftId, nodeType: node.type, text: '' },
    ]);
    if (!insertNoticeShown && typeof ctx.persistDraft !== 'function') {
      insertNoticeShown = true;
      ctx.toast(
        'New paragraph added as a local draft — this API build has no paragraph-creation endpoint (#372)',
        'info'
      );
    }
    focusNodeId = draftId;
    render();
  }

  // Text typed into a draft lives in its insert op so it survives replays;
  // when the API serves paragraph creation (#372), a draft with real content
  // and a real (non-draft) anchor is persisted immediately.
  function updateLocalDraft(spec, node, newText) {
    const ops = restructureOps.get(spec.tree.id) ?? [];
    const op = ops.find((entry) => entry.op === 'insert' && entry.nodeId === node.id);
    if (!op) return;
    op.text = newText;
    node.text = newText;
    void persistEligibleDrafts(spec);
  }

  // Persists drafts through POST /specs/:id/paragraphs, oldest-eligible first.
  // A draft is eligible once it has non-empty text and its anchor is a real
  // server node — a chained draft becomes eligible when its anchor persists
  // (the remap below), so the loop cascades. On failure the draft stays local
  // and replayable; nothing is lost.
  async function persistEligibleDrafts(spec) {
    if (typeof ctx.persistDraft !== 'function') return;
    const specId = spec.tree.id;
    for (;;) {
      const ops = restructureOps.get(specId) ?? [];
      const op = ops.find(
        (entry) =>
          entry.op === 'insert' &&
          !entry.afterId.startsWith('local-') &&
          entry.text.trim().length > 0
      );
      if (!op) return;
      try {
        const created = await ctx.persistDraft(spec, {
          anchorNodeId: op.afterId,
          text: op.text,
          nodeType: op.nodeType,
        });
        // The node is server truth now: drop the insert op and point any ops
        // that referenced the draft id (moves on it, drafts anchored on it) at
        // the real node so the preview replays cleanly.
        const remaining = (restructureOps.get(specId) ?? []).filter((entry) => entry !== op);
        for (const entry of remaining) {
          if (entry.nodeId === op.nodeId) entry.nodeId = created.id;
          if (entry.op === 'insert' && entry.afterId === op.nodeId) entry.afterId = created.id;
        }
        restructureOps.set(specId, remaining);
        // The persist pipeline's own repaint ran while the insert op still
        // existed (draft + real node both drawn) — replay now that it's gone.
        requestRender();
      } catch (err) {
        ctx.toast(`draft not saved: ${err.message} — kept as a local draft`, 'warn');
        return;
      }
    }
  }

  // The spec to draw: server truth, or the restructure-preview overlay when
  // this spec has surviving ops. Ops that stopped applying (node deleted
  // server-side) are pruned here so the count stays honest.
  function overlaidSpec(baseSpec) {
    const ops = restructureOps.get(baseSpec.tree.id) ?? [];
    if (ops.length === 0) return { spec: baseSpec, previewCount: 0 };
    const { parts, applied } = applyRestructureOps(baseSpec.tree.parts, ops);
    if (applied.length !== ops.length) restructureOps.set(baseSpec.tree.id, applied);
    if (applied.length === 0) return { spec: baseSpec, previewCount: 0 };
    return {
      spec: { ...baseSpec, tree: { ...baseSpec.tree, parts } },
      previewCount: applied.length,
    };
  }

  function renderPreviewChip(toolbar, specId, previewCount) {
    const wrap = el('span', 'ed-preview');
    const chip = el('span', 'ed-preview-chip', `LOCAL PREVIEW · ${previewCount}`);
    chip.title =
      'Tab/Shift+Tab restructuring and Enter-inserted paragraphs are applied locally and renumbered live; the API has no restructure (#371) or paragraph-creation (#372) endpoint yet, so they are not persisted.';
    wrap.appendChild(chip);
    const reset = el('button', 'ed-preview-reset', 'RESET');
    reset.type = 'button';
    reset.title = 'Discard the local structure preview (including drafts) and show server truth';
    reset.addEventListener('click', () => {
      restructureOps.delete(specId);
      render();
    });
    wrap.appendChild(reset);
    toolbar.prepend(wrap);
  }

  function renderMain() {
    main.replaceChildren();
    const baseSpec = selectedSection ? specFor(selectedSection) : null;
    if (!baseSpec) {
      const empty = el('div', 'ed-empty');
      empty.appendChild(el('h2', null, 'NO SECTION SELECTED'));
      empty.appendChild(
        el('p', null, 'Pick a section from the Project TOC, or add one from your source libraries.')
      );
      main.appendChild(empty);
      return;
    }
    const { spec, previewCount } = overlaidSpec(baseSpec);

    const toolbar = el('div', 'ed-toolbar');
    if (flagged.has(selectedSection)) {
      const badge = el('span', 'ed-flag-badge', 'FLAGGED FOR REMOVAL');
      badge.title = 'Struck in the TOC and held in the review queue — confirm removal there';
      toolbar.appendChild(badge);
    } else {
      const flag = el('button', 'ed-flag-btn', 'REMOVE SECTION');
      flag.type = 'button';
      flag.title =
        'Flag this section for removal — it is struck in the TOC and held in the review queue until you confirm';
      flag.addEventListener('click', () => {
        flagged.add(selectedSection);
        render();
      });
      toolbar.appendChild(flag);
    }
    if (previewCount > 0) renderPreviewChip(toolbar, spec.tree.id, previewCount);
    main.appendChild(toolbar);

    if (flagged.has(selectedSection)) {
      main.appendChild(
        el(
          'div',
          'ed-flag-banner',
          'This section is struck in the TOC and held in the review queue. Confirm removal there — inbound cross-references will break when it leaves the project.'
        )
      );
    }

    const sheetCtx = ctx.makeSheetCtx({
      onNavigate: (section) => openSection(section),
      inlineEditing: true,
      onRestructure: (node, dir, pendingText = null) =>
        handleRestructure(spec, node, dir, pendingText),
      onInsertAfter: (node, pendingText = null) => handleInsertAfter(spec, node, pendingText),
      onLocalDraftEdit: (node, newText) => updateLocalDraft(spec, node, newText),
      // A cancelled removed-reference dialog must also undo the pendingText
      // mirror handleRestructure/handleInsertAfter wrote onto server truth.
      onEditCancelled: (node, oldText) => {
        const base = ctx.getSpecs().get(spec.tree.id);
        const baseNode = base ? findBaseNode(base.tree.parts, node.id) : null;
        if (baseNode) baseNode.text = oldText;
        focusNodeId = node.id;
        render();
      },
    });
    const sheet = renderSpecSheet(spec, sheetCtx);
    // The map board renders this same spec with id `sheet-<id>`; re-id the
    // editor copy so document ids stay unique.
    sheet.id = `editor-sheet-${spec.tree.id}`;
    main.appendChild(sheet);

    const hints = el('div', 'ed-hints');
    hints.appendChild(el('span', null, 'CLICK INTO ANY TEXT TO EDIT'));
    hints.appendChild(el('span', null, 'TAB / SHIFT+TAB · INDENT & RENUMBER'));
    hints.appendChild(el('span', null, 'ENTER · NEW PARAGRAPH, SAME LEVEL'));
    hints.appendChild(el('span', null, 'CHANGES SAVE WHEN YOU CLICK AWAY'));
    hints.appendChild(el('span', null, '⊘ REMOVE IS REVERSIBLE (OWNER RENDERS ONLY)'));
    hints.appendChild(el('span', null, "BOLDING / UNDERLINING INDIVIDUAL WORDS ISN'T SUPPORTED"));
    main.appendChild(hints);

    if (walkTarget) {
      const target = walkTarget;
      walkTarget = null;
      requestAnimationFrame(() => {
        const link = sheet.querySelector(`.ref-link[data-section="${CSS.escape(target)}"]`);
        if (link) locateLink(link);
      });
    }
    if (focusNodeId) {
      const target = focusNodeId;
      focusNodeId = null;
      requestAnimationFrame(() => {
        const host = sheet.querySelector(`[data-node-id="${CSS.escape(target)}"]`);
        if (!host) return;
        expandAncestors(host);
        host.querySelector('.wys-run')?.focus();
      });
    }
  }

  // ── right inspector ───────────────────────────────────────────────────────

  function outboundOf(spec) {
    const bySection = new Map(); // targetSection -> { broken }
    for (const ref of spec.references) {
      if (!ref.targetSection || ref.targetSection === spec.tree.section) continue;
      const prev = bySection.get(ref.targetSection) ?? { broken: false };
      bySection.set(ref.targetSection, { broken: prev.broken || Boolean(ref.isBroken) });
    }
    return [...bySection.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  function inboundOf(section) {
    const sources = new Map(); // sourceSection -> title
    for (const spec of ctx.getSpecs().values()) {
      if (spec.tree.section === section) continue;
      if (spec.references.some((ref) => ref.targetSection === section)) {
        sources.set(spec.tree.section, spec.tree.title || 'Untitled Section');
      }
    }
    return [...sources.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  function editabilityTallies(spec) {
    const tallies = new Map();
    const walk = (node) => {
      const value = node.meta?.editability?.override ?? node.meta?.editability?.value;
      if (value) tallies.set(value, (tallies.get(value) ?? 0) + 1);
      for (const child of node.children) walk(child);
    };
    for (const node of spec.tree.parts) walk(node);
    return tallies;
  }

  function refRow(section, title, { broken = false } = {}) {
    const row = el('button', 'ed-ref');
    row.type = 'button';
    if (broken) row.classList.add('is-broken');
    const dot = el('span', 'ed-ref-dot');
    row.appendChild(dot);
    row.appendChild(el('span', 'ed-ref-num', ctx.displaySection(section)));
    row.appendChild(el('span', 'ed-ref-title', title));
    const loaded = specFor(section) !== null;
    if (loaded) {
      row.title = `Open Section ${ctx.displaySection(section)} in the editor`;
      row.addEventListener('click', () => openSection(section));
    } else {
      row.classList.add('is-ghost');
      row.title = broken
        ? 'Broken — the target section is not in this project'
        : 'The target section is not loaded in this project';
    }
    return row;
  }

  function renderInspector() {
    inspector.replaceChildren();
    const spec = selectedSection ? specFor(selectedSection) : null;
    inspector.appendChild(el('div', 'ed-insp-head', 'SECTION INSPECTOR'));
    if (!spec) return;

    const outbound = outboundOf(spec);
    inspector.appendChild(el('div', 'ed-insp-cap', `CITES (${outbound.length})`));
    const outList = el('div', 'ed-insp-list');
    for (const [section, info] of outbound) {
      const title = specFor(section)?.tree.title ?? (info.broken ? 'not in project — broken' : 'not loaded');
      outList.appendChild(refRow(section, title, info));
    }
    if (outbound.length === 0) outList.appendChild(el('p', 'ed-insp-none', 'no outbound citations'));
    inspector.appendChild(outList);

    const inbound = inboundOf(spec.tree.section);
    inspector.appendChild(el('div', 'ed-insp-cap', `CITED BY (${inbound.length})`));
    const inList = el('div', 'ed-insp-list');
    for (const [section, title] of inbound) inList.appendChild(refRow(section, title));
    if (inbound.length === 0) {
      inList.appendChild(el('p', 'ed-insp-none', 'no project section cites this one'));
    }
    inspector.appendChild(inList);

    const tallies = editabilityTallies(spec);
    if (tallies.size > 0) {
      inspector.appendChild(el('div', 'ed-insp-cap', 'EDITABILITY'));
      const chips = el('div', 'ed-insp-chips');
      for (const [value, count] of [...tallies.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        chips.appendChild(el('span', `ed-chip ed-chip-${value}`, `${value.toUpperCase()} ${count}`));
      }
      inspector.appendChild(chips);
    }
  }

  // ── controller ────────────────────────────────────────────────────────────

  // Render now unless it would destroy in-progress typing — then defer to the
  // focusout replay. Shared by onDataChanged and the draft-persist loop.
  function requestRender() {
    if (!ctx.isActive()) return;
    if (editingRunIsFocused()) {
      deferredRender = true;
      return;
    }
    render();
  }

  // True while the caret sits in one of the sheet's inline-editable runs —
  // re-rendering then would detach the focused element and eat the typing.
  function editingRunIsFocused() {
    const active = document.activeElement;
    return (
      active instanceof Element && active.classList.contains('wys-run') && main.contains(active)
    );
  }

  function render() {
    deferredRender = false;
    // A section removed from another view (map DELETE, project switch) must
    // not linger as a ghost flag or a stale selection.
    const live = new Set(entries().map((e) => e.section));
    for (const section of [...flagged]) {
      if (!live.has(section)) flagged.delete(section);
    }
    ensureSelection();
    renderRail();
    renderMain();
    renderInspector();
  }

  // Replays a deferred refresh once the caret leaves the sheet. The timeout
  // lets the run's own blur handler commit first; if focus just moved to
  // another run, stay deferred until that edit finishes too.
  main.addEventListener('focusout', () => {
    if (!deferredRender) return;
    setTimeout(() => {
      if (!deferredRender || editingRunIsFocused()) return;
      if (ctx.isActive()) render();
      else deferredRender = false;
    }, 0);
  });

  function openSection(section, { walkTo = null } = {}) {
    selectedSection = section;
    walkTarget = walkTo;
    render();
    main.scrollTop = 0;
  }

  return {
    // Re-render on every entry: rail counts and citation statuses must reflect
    // whatever changed while another view was active.
    refresh() {
      render();
    },
    open(section, opts) {
      openSection(section, opts);
    },
    isFlagged: (section) => flagged.has(section),
    // Board mutations re-render only when the view is visible; entering the
    // view calls refresh(), so a hidden editor never renders stale state.
    // Mid-edit refreshes (another paragraph's blur-save landing) are deferred
    // until the caret leaves the sheet, or they would destroy typing.
    onDataChanged() {
      requestRender();
    },
    // Workspace swap (project switch/create/delete/restore): flags and
    // selection belong to the old project — drop them.
    reset() {
      flagged.clear();
      collapsed.clear();
      restructureOps.clear();
      selectedSection = null;
      walkTarget = null;
      focusNodeId = null;
      if (ctx.isActive()) render();
    },
  };
}
