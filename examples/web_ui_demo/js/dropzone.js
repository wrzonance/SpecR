// Drag-and-drop ingest: full-window drop target, sequential upload queue, and
// per-file parse-job progress.

import {
  uploadSpec,
  waitForParseJob,
  importSpecToLibrary,
  waitForImportJob,
} from './api.js';

const ACCEPTED = new Set(['.sec', '.docx', '.txt']);
const DEFAULT_CONTEXT = { destination: 'project', source: 'master' };

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

export function initDropzone({ onSpecReady, onReject, getDropContext, onAddSectionsClick }) {
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
      const onTick = (job) =>
        setStage(item, stageText(job), job.progress ? job.progress.pct : undefined);
      // Whenever we know the target library, ONBOARD the spec into it
      // (POST /libraries/:id/import) so it actually joins that library. This
      // covers a library-view upload AND a project-map upload (the map passes
      // the project's base source library so the section can later resolve a
      // project copy). POST /parse only creates an orphaned standalone spec
      // that never joins a library or project, so it's the library-less
      // fallback. The `destination` field still drives post-processing in
      // onSpecReady (library refresh vs. project join).
      let result;
      if (context.libraryId) {
        const { jobId } = await importSpecToLibrary(file, context.libraryId);
        result = await waitForImportJob(jobId, onTick);
      } else {
        const { jobId } = await uploadSpec(file, {
          importDestination: context.destination,
          importLibrary: context.library || context.source,
          importClient: context.client,
        });
        result = await waitForParseJob(jobId, onTick);
      }
      item.li.classList.add('is-complete');
      const done =
        typeof result.nodeCount === 'number' ? `${result.nodeCount} nodes` : result.section;
      setStage(item, `complete — ${done}`, 100);
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

  function chooseFiles(context = DEFAULT_CONTEXT) {
    input.dataset.context = JSON.stringify(context);
    input.click();
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
    chooseFiles(DEFAULT_CONTEXT);
  });
  addFab.addEventListener('click', async () => {
    if (!onAddSectionsClick) {
      chooseFiles(DEFAULT_CONTEXT);
      return;
    }
    await onAddSectionsClick({ chooseFiles, defaultContext: DEFAULT_CONTEXT });
  });
  input.addEventListener('change', () => {
    const context = input.dataset.context ? JSON.parse(input.dataset.context) : DEFAULT_CONTEXT;
    if (input.files && input.files.length > 0) accept([...input.files], context);
    delete input.dataset.context;
    input.value = '';
  });
}
