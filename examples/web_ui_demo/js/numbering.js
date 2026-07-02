// Numbering Profiles workspace (#299 / #317 / #320).
//
// A numbering profile is the outline-numbering scheme a library writes to — how
// many Parts a section has, which Word outline level its Articles start on, and
// the label style (commercial 1.01 / A. / 1. vs all-numeric 1.1 / 1.1.1) — saved
// as an editable, library-scoped profile so specs parsed into that library
// inherit it. This panel covers the full suite: per-library CRUD, reading a
// scheme from a sample .docx (POST /numbering-profiles/snapshot, no persistence),
// and saving that read-back scheme as a library profile. Applying a profile at
// parse time is a POST /parse capability (numberingProfileId); the demo's
// library-import flow does not surface it yet.

import { API_FEATURES } from './features.js';
import {
  listNumberingProfiles,
  createNumberingProfile,
  deleteNumberingProfile,
  snapshotNumberingProfile,
} from './api.js';
import { openConfirm } from './modal.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// One-line, spec-writer-facing summary of a NumberingProfile `rules` object.
// The "Word lists" / "style links" counts only appear once a scheme has been
// read from a Word document (they are always empty for a form-created profile).
function rulesSummary(rules) {
  const maxParts = rules?.tiers?.part?.maxCount;
  const article = rules?.articleIlvl;
  const maps = Array.isArray(rules?.numbering) ? rules.numbering.length : 0;
  const ladder = Array.isArray(rules?.styleLadder) ? rules.styleLadder.length : 0;
  const parts = [
    `up to ${maxParts ?? '—'} Part${maxParts === 1 ? '' : 's'}`,
    `Articles at level ${article ?? '—'}`,
  ];
  if (maps > 0) parts.push(`${maps} Word list${maps === 1 ? '' : 's'}`);
  if (ladder > 0) parts.push(`${ladder} style link${ladder === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// Minimal valid NumberingProfile from the create form's coarse inputs. numbering
// and styleLadder are legitimately empty (the CSI integer-PART model needs no
// numId map to be well-formed); articleIlvl is omitted when blank.
function rulesFromForm(maxParts, articleIlvl) {
  const rules = {
    tiers: { part: { numberStyle: 'integer', maxCount: maxParts } },
    numbering: [],
    styleLadder: [],
  };
  if (Number.isInteger(articleIlvl)) rules.articleIlvl = articleIlvl;
  return rules;
}

export function initNumbering({ getLibraries, toast }) {
  const librarySelect = document.getElementById('numbering-library-select');
  const list = document.getElementById('numbering-profile-list');
  const createForm = document.getElementById('numbering-create-form');
  const nameInput = document.getElementById('numbering-name-input');
  const maxPartsInput = document.getElementById('numbering-maxparts-input');
  const articleInput = document.getElementById('numbering-articleilvl-input');
  const snapshotDrop = document.getElementById('numbering-snapshot-drop');
  const snapshotInput = document.getElementById('numbering-snapshot-input');
  const snapshotResult = document.getElementById('numbering-snapshot-result');

  if (!librarySelect || !list) return { refresh: async () => {} };

  let snapshot = null; // last extracted rules, pending "save to library"

  function selectedLibraryId() {
    return librarySelect.value || null;
  }

  function renderProfileRow(profile) {
    const row = el('div', 'numbering-profile');
    const builtIn = profile.libraryId === null;
    const head = el('div', 'numbering-profile-head');
    head.appendChild(el('span', 'numbering-profile-name', profile.name));
    if (builtIn) head.appendChild(el('span', 'numbering-badge', 'BUILT-IN'));
    row.appendChild(head);
    row.appendChild(el('p', 'numbering-profile-summary', rulesSummary(profile.rules)));
    if (!builtIn) {
      const del = el('button', 'toc-btn is-danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => removeProfile(profile));
      row.appendChild(del);
    } else {
      row.appendChild(
        el(
          'p',
          'numbering-profile-note',
          'The standard CSI scheme SpecR falls back to for any spec that has no profile of its own. It cannot be edited or deleted.'
        )
      );
    }
    return row;
  }

  function renderProfiles(profiles) {
    list.replaceChildren();
    if (profiles.length === 0) {
      list.appendChild(el('p', 'numbering-empty', 'No numbering profiles for this library.'));
      return;
    }
    for (const profile of profiles) list.appendChild(renderProfileRow(profile));
  }

  async function loadProfiles() {
    const libraryId = selectedLibraryId();
    if (!libraryId) {
      list.replaceChildren(el('p', 'numbering-empty', 'Select a library to view its profiles.'));
      return;
    }
    try {
      const profiles = await listNumberingProfiles(libraryId);
      renderProfiles(profiles);
    } catch (err) {
      list.replaceChildren(el('p', 'numbering-empty', `Could not load profiles: ${err.message}`));
    }
  }

  function populateLibrarySelect() {
    const libraries = getLibraries();
    const previous = selectedLibraryId();
    librarySelect.replaceChildren();
    for (const library of libraries) {
      const option = el('option', null, library.name);
      option.value = library.id;
      librarySelect.appendChild(option);
    }
    if (previous && libraries.some((library) => library.id === previous)) {
      librarySelect.value = previous;
    }
  }

  async function removeProfile(profile) {
    const ok = await openConfirm({
      title: 'Delete numbering profile',
      body: `Delete "${profile.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteNumberingProfile(profile.id);
      toast(`Deleted "${profile.name}"`);
      await loadProfiles();
    } catch (err) {
      const reason =
        err.status === 409
          ? 'profile is in use by a spec (or is the built-in default)'
          : err.message;
      toast(`Could not delete: ${reason}`, 'err');
    }
  }

  async function submitCreate(event) {
    event.preventDefault();
    const libraryId = selectedLibraryId();
    if (!libraryId) return toast('Select a library first', 'err');
    const name = nameInput.value.trim();
    if (!name) return toast('Profile name is required', 'err');
    const maxParts = Number.parseInt(maxPartsInput.value, 10);
    if (!(maxParts >= 1 && maxParts <= 5)) return toast('Parts must be between 1 and 5', 'err');
    const articleRaw = articleInput.value.trim();
    const articleIlvl = articleRaw === '' ? null : Number.parseInt(articleRaw, 10);
    if (articleIlvl !== null && !(articleIlvl >= 1)) return toast('Article level must be ≥ 1', 'err');
    try {
      await createNumberingProfile(libraryId, name, rulesFromForm(maxParts, articleIlvl));
      toast(`Created "${name}"`);
      nameInput.value = '';
      await loadProfiles();
    } catch (err) {
      const reason = err.status === 422 ? 'invalid profile rules' : err.message;
      toast(`Could not create: ${reason}`, 'err');
    }
    return undefined;
  }

  function renderSnapshot(rules) {
    snapshot = rules;
    snapshotResult.replaceChildren();
    const card = el('div', 'numbering-snapshot-card');
    card.appendChild(el('p', 'numbering-snapshot-summary', rulesSummary(rules)));
    const pre = el('pre', 'numbering-snapshot-json', JSON.stringify(rules, null, 2));
    card.appendChild(pre);
    const save = el('form', 'numbering-snapshot-save');
    const nameField = el('input');
    nameField.type = 'text';
    nameField.placeholder = 'Save as… (profile name)';
    const saveBtn = el('button', 'toc-btn is-primary', 'Save to Library');
    saveBtn.type = 'submit';
    save.append(nameField, saveBtn);
    save.addEventListener('submit', (event) => saveSnapshot(event, nameField));
    card.appendChild(save);
    snapshotResult.appendChild(card);
  }

  async function saveSnapshot(event, nameField) {
    event.preventDefault();
    const libraryId = selectedLibraryId();
    if (!libraryId) return toast('Select a library first', 'err');
    const name = nameField.value.trim();
    if (!name) return toast('Profile name is required', 'err');
    if (!snapshot) return toast('Extract a snapshot first', 'err');
    try {
      await createNumberingProfile(libraryId, name, snapshot);
      toast(`Saved "${name}" to the selected library`);
      snapshotResult.replaceChildren();
      snapshot = null;
      await loadProfiles();
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'err');
    }
    return undefined;
  }

  async function extractSnapshot(file) {
    snapshotResult.replaceChildren(el('p', 'numbering-empty', `Extracting from ${file.name}…`));
    try {
      const rules = await snapshotNumberingProfile(file);
      renderSnapshot(rules);
    } catch (err) {
      const reason = err.status === 400 ? 'file must be a .docx' : err.message;
      snapshotResult.replaceChildren(el('p', 'numbering-empty', `Extraction failed: ${reason}`));
    }
  }

  librarySelect.addEventListener('change', () => void loadProfiles());
  createForm?.addEventListener('submit', (event) => void submitCreate(event));
  // Click anywhere in the area to browse. Dropping is intentionally not wired: the
  // global ingest dropzone shows a full-screen veil on any drag and would swallow
  // the file into the project queue — so the extractor is browse-only, on purpose.
  snapshotDrop?.addEventListener('click', () => snapshotInput?.click());
  snapshotInput?.addEventListener('change', () => {
    const file = snapshotInput.files?.[0];
    if (file) void extractSnapshot(file);
    snapshotInput.value = '';
  });

  async function refresh() {
    if (!API_FEATURES.numberingProfiles) return;
    populateLibrarySelect();
    await loadProfiles();
  }

  return { refresh };
}
