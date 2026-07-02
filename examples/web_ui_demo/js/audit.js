// Live Coordination Audit view (ADR-041): the Report tab renders coordination
// findings (left pane) beside the spec they cite (right pane). Selecting a
// finding opens its section in the spec pane and scrolls to the exact paragraph;
// a hover/keyboard walker steps through findings, driving both panes; and
// clicking a paragraph or citation in the spec reflects back to the finding.
//
// Reuses, rather than reinvents: the paragraph anchor already in the payload and
// the DOM (finding.sourceSpecId → #sheet-<id>, finding.sourceParagraphId →
// [data-node-id]); the spec-map hover-walker (popover.js createHoverWalker); and
// expandAncestors (tree.js).

import { createHoverWalker } from './popover.js';
import { expandAncestors } from './tree.js';

const EMPTY_MESSAGE =
  'Select a coordination finding on the left to read the exact paragraph it ' +
  'points to — the section opens here and scrolls to the cited line.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Section numbers and paragraph UUIDs never contain a double-quote, so a quoted
// attribute selector is safe; guard against a stray quote just in case.
function attrSelector(attr, value) {
  return value.includes('"') ? null : `[${attr}="${value}"]`;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Reveal a finding that sits inside collapsed tree levels so its selection shows.
// Walks section → division → category, opening any closed ancestor.
function expandGroup(row) {
  for (const level of ['coord-sec', 'coord-div', 'coord-group']) {
    const anc = row.closest(`.${level}`);
    if (anc && anc.classList.contains('is-closed')) {
      anc.classList.remove('is-closed');
      const head = anc.querySelector(`:scope > .${level}-head`);
      if (head) head.setAttribute('aria-expanded', 'true');
    }
  }
}

export function initAudit(opts) {
  const {
    findingsPane,
    specPane,
    specTitleEl,
    specHintEl,
    split,
    divider,
    getLoadedSpec,
    fetchSpec,
    resolveSection,
    renderSheet,
    displaySection,
  } = opts;

  let paneSpecId = null; // spec currently rendered on the right
  let paneRequestId = 0; // monotonic guard: drop a stale ensureSpec resolution (rapid stepping)
  let selectedRow = null; // selected finding row on the left
  let locatedNode = null; // highlighted paragraph in the pane

  // ── Right pane: render + paragraph locate ────────────────────────────────
  function setPaneHead(title, hint) {
    if (specTitleEl) specTitleEl.textContent = title;
    if (specHintEl) specHintEl.textContent = hint;
  }

  function showEmptyPane(message, title = 'CITED SECTION', hint = 'no section selected') {
    paneSpecId = null;
    locatedNode = null;
    specPane.replaceChildren(el('p', 'audit-empty', message));
    setPaneHead(title, hint);
  }

  async function ensureSpec(specId) {
    if (paneSpecId === specId) return specPane.querySelector('.spec-sheet');
    // Rapid keyboard/hover stepping fires ensureSpec concurrently for different specs;
    // a slower earlier fetch must not clobber the pane a faster later one already set.
    const requestId = ++paneRequestId;
    let spec = getLoadedSpec(specId);
    if (!spec || !spec.tree) {
      try {
        spec = await fetchSpec(specId);
      } catch {
        if (requestId === paneRequestId) showEmptyPane('Could not load this section.');
        return null;
      }
    }
    if (requestId !== paneRequestId) return null; // superseded by a newer selection
    if (!spec || !spec.tree) {
      showEmptyPane('Could not load this section.');
      return null;
    }
    const sheet = renderSheet(spec, reflectSection);
    // Drop the duplicate id so it never collides with the board's sheet-<id>;
    // we hold the element reference and query it directly.
    sheet.removeAttribute('id');
    specPane.replaceChildren(sheet);
    paneSpecId = specId;
    locatedNode = null;
    setPaneHead(
      spec.tree.section ? displaySection(spec.tree.section) : 'Section',
      spec.tree.title || 'Untitled Section'
    );
    return sheet;
  }

  // Smooth scroll can take a moment; defer the pulse until the row is actually
  // visible inside the pane (mirrors tree.js pulseOnArrival, scoped to the pane).
  function pulseNode(node) {
    const observer = new IntersectionObserver(
      (entries, obs) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        obs.disconnect();
        node.classList.remove('is-audit-pulse');
        void node.offsetWidth; // restart the animation
        node.classList.add('is-audit-pulse');
        node.addEventListener('animationend', () => node.classList.remove('is-audit-pulse'), {
          once: true,
        });
      },
      // threshold 0: a container paragraph can be taller than the pane, so its
      // intersectionRatio never reaches a high threshold — fire on any overlap.
      { root: specPane, threshold: 0 }
    );
    observer.observe(node);
    setTimeout(() => observer.disconnect(), 10000); // hygiene
  }

  function locateNode(node) {
    expandAncestors(node);
    if (locatedNode && locatedNode !== node) {
      locatedNode.classList.remove('is-audit-target', 'is-audit-pulse');
    }
    locatedNode = node;
    node.classList.add('is-audit-target');
    node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    pulseNode(node);
  }

  // Highlight a section head when a finding has no paragraph-level anchor — the
  // head IS the relevant target for section-level findings. Reuses the same
  // target+pulse treatment but anchors to the top of the sheet.
  function locateHead(head) {
    if (locatedNode && locatedNode !== head) {
      locatedNode.classList.remove('is-audit-target', 'is-audit-pulse');
    }
    locatedNode = head;
    head.classList.add('is-audit-target');
    head.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    pulseNode(head);
  }

  async function openSheet(specId, paragraphId) {
    const sheet = await ensureSpec(specId);
    if (!sheet) return;
    if (paragraphId) {
      const selector = attrSelector('data-node-id', paragraphId);
      const node = selector ? sheet.querySelector(selector) : null;
      if (node) {
        locateNode(node);
        return;
      }
    }
    // No paragraph anchor (or the row is absent) — highlight the section head so
    // every finding still gives a visible "you are here" signal, not just a
    // silent scroll to the top.
    const head = sheet.querySelector('.sheet-head');
    if (head) {
      locateHead(head);
      return;
    }
    if (locatedNode) {
      locatedNode.classList.remove('is-audit-target', 'is-audit-pulse');
      locatedNode = null;
    }
    specPane.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // ── Left pane: finding selection ─────────────────────────────────────────
  function selectRow(row) {
    if (selectedRow && selectedRow !== row) selectedRow.classList.remove('is-selected');
    selectedRow = row;
    expandGroup(row); // a selected finding must be visible, even in a closed group
    row.classList.add('is-selected');
    row.scrollIntoView({ block: 'nearest' });
  }

  // Drive both panes from a finding row's data-* anchor.
  async function locateFinding(row) {
    selectRow(row);
    const { specId, paragraphId, section } = row.dataset;
    if (specId) {
      await openSheet(specId, paragraphId || null);
      return;
    }
    // Section-only finding with no source spec (e.g. a required section missing
    // from the project). Open the section's spec if it is loaded, else explain.
    const resolved = section ? resolveSection(section) : undefined;
    if (resolved) {
      await openSheet(resolved, null);
      return;
    }
    const label = section ? displaySection(section) : 'This section';
    showEmptyPane(
      `${label} is referenced by this finding but is not loaded in the project.`,
      section ? displaySection(section) : 'CITED SECTION',
      'not loaded in this project'
    );
  }

  // ── Reflection: spec pane → finding (bidirectional) ──────────────────────
  // When anchors collide (several findings share a section or paragraph), prefer
  // the finding for the spec currently in the pane, else the first match.
  function pickRow(selector) {
    if (!selector) return null;
    const rows = [...findingsPane.querySelectorAll(`.coord-finding${selector}`)];
    return rows.find((row) => row.dataset.specId === paneSpecId) ?? rows[0] ?? null;
  }

  function reflectSection(section) {
    const row = pickRow(attrSelector('data-section', section));
    if (row) selectRow(row);
  }

  function reflectParagraph(nodeId) {
    const row = pickRow(attrSelector('data-paragraph-id', nodeId));
    if (row) selectRow(row);
  }

  // Public: open a section's spec in the pane (sheet-level). Used by the
  // open-comments section badges so they stay in the Report.
  async function showSection(section) {
    const specId = resolveSection(section);
    if (specId) await openSheet(specId, null);
  }

  // Public: focus a chat answer anchor {section, specId?, paragraphId?} — scroll
  // to and pulse the EXACT paragraph, not just the section head. Uses the
  // anchor's own specId so the paragraphId is guaranteed to belong to the opened
  // sheet; falls back to the loaded copy for the section when the anchor carries
  // no specId, and explains in the pane when nothing resolves.
  async function showAnchor(anchor) {
    if (!anchor) return;
    const specId = anchor.specId || resolveSection(anchor.section);
    if (!specId) {
      const label = anchor.section ? displaySection(anchor.section) : 'This section';
      showEmptyPane(
        `${label} is not loaded in this project.`,
        anchor.section ? displaySection(anchor.section) : 'CITED SECTION',
        'not loaded in this project'
      );
      return;
    }
    await openSheet(specId, anchor.paragraphId || null);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  findingsPane.addEventListener('click', (event) => {
    const row = event.target.closest?.('.coord-finding');
    if (row && findingsPane.contains(row)) void locateFinding(row);
  });

  specPane.addEventListener('click', (event) => {
    if (event.target.closest?.('.ref-link')) return; // citation handled by onNavigate
    const node = event.target.closest?.('[data-node-id]'); // paragraph OR note row
    if (node && node.dataset.nodeId) reflectParagraph(node.dataset.nodeId);
  });

  createHoverWalker({
    itemSelector: '.coord-finding',
    listFor: (anchor) => [
      ...(anchor.closest('.audit-findings')?.querySelectorAll('.coord-finding') ?? []),
    ],
    onStep: (row) => void locateFinding(row),
    prevTitle: 'Previous finding',
    nextTitle: 'Next finding',
    popClass: 'audit-pop',
    keyboard: true,
    hideOnItemClick: false,
  });

  initResizer();

  function initResizer() {
    if (!divider || !split) return;
    let frac = 0.5;
    let dragging = false;
    function apply() {
      split.style.setProperty('--audit-left', `${frac}fr`);
      split.style.setProperty('--audit-right', `${1 - frac}fr`);
      divider.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    }
    function setFromClientX(clientX) {
      const rect = split.getBoundingClientRect();
      if (rect.width === 0) return;
      frac = Math.min(0.8, Math.max(0.2, (clientX - rect.left) / rect.width));
      apply();
    }
    divider.addEventListener('pointerdown', (event) => {
      dragging = true;
      divider.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    divider.addEventListener('pointermove', (event) => {
      if (dragging) setFromClientX(event.clientX);
    });
    function endDrag(event) {
      dragging = false;
      try {
        divider.releasePointerCapture(event.pointerId);
      } catch {
        // pointer capture may already be released — safe to ignore
      }
    }
    divider.addEventListener('pointerup', endDrag);
    divider.addEventListener('pointercancel', endDrag);
    divider.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        frac = Math.max(0.2, frac - 0.05);
        apply();
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        frac = Math.min(0.8, frac + 0.05);
        apply();
        event.preventDefault();
      }
    });
    apply();
  }

  // The split fills from its own top to the viewport bottom so each pane scrolls
  // on its own — MEASURED (not a hardcoded chrome estimate that under-subtracts
  // the masthead+nav+project-bar) and re-measured on resize. A no-op while the
  // Report view is hidden (offsetParent === null); app.js calls fit() on show.
  function fitHeight() {
    if (!split || split.offsetParent === null) return;
    const top = split.getBoundingClientRect().top;
    split.style.setProperty(
      '--audit-h',
      `${Math.max(320, Math.round(window.innerHeight - top))}px`
    );
  }
  window.addEventListener('resize', fitHeight);

  fitHeight();
  showEmptyPane(EMPTY_MESSAGE);
  return { showSection, showAnchor, fit: fitHeight, reset: () => showEmptyPane(EMPTY_MESSAGE) };
}
