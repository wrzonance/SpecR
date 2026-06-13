// Drag-and-drop ingest: full-window drop target, sequential upload queue, and
// per-file parse-job progress.

import { listLibraries, uploadSpec, waitForParseJob } from './api.js';
import { openChoice } from './modal.js';

const ACCEPTED = new Set(['.sec', '.docx', '.txt']);
const DEFAULT_CONTEXT = { destination: 'project', source: 'master' };
const COMPANY_MASTER_NAME = 'Default Company Master';

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

function stageText(job) {
  const pct = job.progress && job.progress.pct ? ` ${job.progress.pct}%` : '';
  return `${job.status}${pct}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectField(label, options) {
  const wrap = el('label', 'modal-field');
  wrap.appendChild(el('span', null, label));
  const select = document.createElement('select');
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  wrap.appendChild(select);
  return { wrap, select };
}

async function loadLibraryChoices() {
  const libraries = await listLibraries();
  return {
    company: libraries.find((lib) => lib.name === COMPANY_MASTER_NAME) || null,
    clients: libraries
      .filter((lib) => lib.tier === 'client')
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function pickClient() {
  const { clients } = await loadLibraryChoices();
  if (clients.length === 0) {
    await openChoice({
      title: 'No client masters',
      body: 'Add a client in the Library tab first.',
      choices: [{ label: 'Close', value: null, kind: 'primary' }],
    });
    return null;
  }
  const field = selectField(
    'Client',
    clients.map((client) => ({ value: client.id, label: client.name }))
  );
  const choice = await openChoice({
    title: 'Select client master',
    body: [field.wrap],
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Use Client', value: 'client', kind: 'primary' },
    ],
  });
  if (!choice) return null;
  const client = clients.find((lib) => lib.id === field.select.value);
  return client ? { id: client.id, name: client.name } : null;
}

async function chooseLibraryContext() {
  const library = await openChoice({
    title: 'Add to library',
    body: 'Choose where these uploaded fixtures should land.',
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Company Masters', value: 'company', kind: 'primary' },
      { label: 'Client Master', value: 'client', kind: 'primary' },
    ],
  });
  if (!library) return null;
  const { company } = await loadLibraryChoices();
  if (library === 'company') {
    return {
      destination: 'library',
      library: 'company',
      libraryId: company?.id,
      libraryName: company?.name || 'Company Masters',
    };
  }
  const client = await pickClient();
  return client
    ? { destination: 'library', library: 'client', libraryId: client.id, client: client.name }
    : null;
}

async function chooseProjectContext() {
  const source = await openChoice({
    title: 'Add to project',
    body: 'Choose which library source the project should pull from.',
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Master Library', value: 'master', kind: 'primary' },
      { label: 'Client Library', value: 'client', kind: 'primary' },
    ],
  });
  if (!source) return null;
  const { company } = await loadLibraryChoices();
  if (source === 'master') {
    return { destination: 'project', source: 'master', libraryId: company?.id };
  }
  const client = await pickClient();
  return client
    ? { destination: 'project', source: 'client', libraryId: client.id, client: client.name }
    : null;
}

async function chooseAddContext() {
  const destination = await openChoice({
    title: 'Add sections',
    body: 'Choose whether these files should become library fixtures or project sections.',
    choices: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Add to Library', value: 'library', kind: 'primary' },
      { label: 'Add to Project', value: 'project', kind: 'primary' },
    ],
  });
  if (destination === 'library') return chooseLibraryContext();
  if (destination === 'project') return chooseProjectContext();
  return null;
}

function contextLabel(context) {
  if (context.destination === 'library') {
    return context.library === 'client'
      ? `library / ${context.client}`
      : `library / ${context.libraryName || 'company masters'}`;
  }
  return context.source === 'client' ? `project / ${context.client}` : 'project / master library';
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function filesFromEntry(entry) {
  if (entry.isFile) return [await readEntryFile(entry)];
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const files = [];
  for (;;) {
    const entries = await readDirectoryEntries(reader);
    if (entries.length === 0) break;
    const nested = await Promise.all(entries.map((child) => filesFromEntry(child)));
    files.push(...nested.flat());
  }
  return files;
}

async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer.items ?? [])];
  if (items.length === 0) return [...dataTransfer.files];
  const files = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) files.push(...(await filesFromEntry(entry)));
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

export function initDropzone({ onSpecReady, onReject, getDropContext }) {
  const veil = document.getElementById('drop-veil');
  const dock = document.getElementById('upload-dock');
  const list = document.getElementById('upload-list');
  const input = document.getElementById('file-input');
  const pickBtn = document.getElementById('pick-btn');
  const addFab = document.getElementById('add-fab');

  const queue = [];
  let working = false;

  function makeItem(file, context) {
    const li = document.createElement('li');
    li.className = 'upload-item';
    const row = document.createElement('div');
    row.className = 'ui-row';
    const name = document.createElement('span');
    name.className = 'ui-name';
    name.textContent = file.name;
    const stage = document.createElement('span');
    stage.className = 'ui-stage';
    stage.textContent = `queued - ${contextLabel(context)}`;
    row.appendChild(name);
    row.appendChild(stage);
    const bar = document.createElement('div');
    bar.className = 'ui-bar';
    const fill = document.createElement('div');
    fill.className = 'ui-fill';
    bar.appendChild(fill);
    li.appendChild(row);
    li.appendChild(bar);
    list.appendChild(li);
    dock.hidden = false;
    return { li, stage, fill };
  }

  function setStage(item, text, pct) {
    item.stage.textContent = text;
    if (pct !== undefined) item.fill.style.width = `${pct}%`;
  }

  function fail(item, error) {
    item.li.classList.add('is-failed');
    setStage(item, 'failed', 100);
    const err = document.createElement('p');
    err.className = 'ui-err';
    const parts = [];
    if (error.status) parts.push(`HTTP ${error.status}`);
    if (error.jobId) parts.push(`job ${error.jobId.slice(0, 8)}`);
    const prefix = parts.length > 0 ? `[${parts.join(' · ')}] ` : '';
    err.textContent = `${prefix}${error.message || 'upload failed'}`;
    item.li.appendChild(err);
    const hint = document.createElement('p');
    hint.className = 'ui-err-hint';
    hint.textContent = 'full server response logged to the browser console (F12)';
    item.li.appendChild(hint);
  }

  async function processOne(entry) {
    const { file, item, context } = entry;
    try {
      setStage(item, 'uploading', 8);
      const { jobId } = await uploadSpec(file, {
        libraryId: context.libraryId,
        importDestination: context.destination,
        importLibrary: context.library || context.source,
        importClient: context.client,
      });
      const result = await waitForParseJob(jobId, (job) => {
        setStage(item, stageText(job), job.progress ? job.progress.pct : undefined);
      });
      item.li.classList.add('is-complete');
      setStage(item, `complete — ${result.nodeCount} nodes`, 100);
      await onSpecReady(result, context);
      setTimeout(() => {
        item.li.remove();
        if (list.children.length === 0) dock.hidden = true;
      }, 4000);
    } catch (err) {
      fail(item, err);
    }
  }

  async function pump() {
    if (working) return;
    working = true;
    while (queue.length > 0) {
      await processOne(queue.shift());
    }
    working = false;
  }

  function accept(files, context = DEFAULT_CONTEXT) {
    let rejected = 0;
    for (const file of files) {
      const ext = extOf(file.name);
      if (!ACCEPTED.has(ext)) {
        rejected += 1;
        continue;
      }
      queue.push({ file, item: makeItem(file, context), context });
    }
    if (rejected > 0) {
      onReject(`${rejected} unsupported file${rejected === 1 ? '' : 's'} skipped`);
    }
    void pump();
  }

  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    veil.hidden = false;
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) veil.hidden = true;
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    veil.hidden = true;
    if (event.dataTransfer) {
      void (async () => {
        try {
          const files = await filesFromDataTransfer(event.dataTransfer);
          if (files.length > 0) accept(files, getDropContext?.() ?? DEFAULT_CONTEXT);
        } catch (err) {
          onReject(`could not read dropped folders: ${err.message}`);
        }
      })();
    }
  });

  pickBtn.addEventListener('click', () => {
    input.dataset.context = JSON.stringify(DEFAULT_CONTEXT);
    input.click();
  });
  addFab.addEventListener('click', async () => {
    try {
      const context = await chooseAddContext();
      if (!context) return;
      input.dataset.context = JSON.stringify(context);
      input.click();
    } catch (err) {
      onReject(`could not load libraries: ${err.message}`);
    }
  });
  input.addEventListener('change', () => {
    const context = input.dataset.context ? JSON.parse(input.dataset.context) : DEFAULT_CONTEXT;
    if (input.files && input.files.length > 0) accept([...input.files], context);
    delete input.dataset.context;
    input.value = '';
  });
}
