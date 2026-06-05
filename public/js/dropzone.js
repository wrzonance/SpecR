// Drag-and-drop ingest: full-window drop target, sequential upload queue,
// per-file parse-job progress, and polite backoff when the /parse rate
// limit (10 uploads/min) pushes back.

import { uploadSpec, waitForParseJob } from './api.js';

const ACCEPTED = new Set(['.sec', '.docx', '.txt']);
const RATE_LIMIT_BACKOFF_MS = 15000;

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

function stageText(job) {
  const pct = job.progress && job.progress.pct ? ` ${job.progress.pct}%` : '';
  return `${job.status}${pct}`;
}

export function initDropzone({ onSpecReady, onReject }) {
  const veil = document.getElementById('drop-veil');
  const dock = document.getElementById('upload-dock');
  const list = document.getElementById('upload-list');
  const input = document.getElementById('file-input');
  const pickBtn = document.getElementById('pick-btn');
  const addFab = document.getElementById('add-fab');

  const queue = [];
  let working = false;

  function makeItem(file) {
    const li = document.createElement('li');
    li.className = 'upload-item';
    const row = document.createElement('div');
    row.className = 'ui-row';
    const name = document.createElement('span');
    name.className = 'ui-name';
    name.textContent = file.name;
    const stage = document.createElement('span');
    stage.className = 'ui-stage';
    stage.textContent = 'queued';
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

  async function uploadWithBackoff(file, item) {
    for (;;) {
      try {
        return await uploadSpec(file);
      } catch (err) {
        if (!err.rateLimited) throw err;
        for (let left = RATE_LIMIT_BACKOFF_MS / 1000; left > 0; left -= 1) {
          setStage(item, `rate limit — retry in ${left}s`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  async function processOne(entry) {
    const { file, item } = entry;
    try {
      setStage(item, 'uploading', 8);
      const { jobId } = await uploadWithBackoff(file, item);
      const result = await waitForParseJob(jobId, (job) => {
        setStage(item, stageText(job), job.progress ? job.progress.pct : undefined);
      });
      item.li.classList.add('is-complete');
      setStage(item, `complete — ${result.nodeCount} nodes`, 100);
      await onSpecReady(result);
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

  function accept(files) {
    for (const file of files) {
      const ext = extOf(file.name);
      if (!ACCEPTED.has(ext)) {
        onReject(`${file.name} — unsupported type (need .SEC, .DOCX, or .TXT)`);
        continue;
      }
      queue.push({ file, item: makeItem(file) });
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
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      accept([...event.dataTransfer.files]);
    }
  });

  pickBtn.addEventListener('click', () => input.click());
  addFab.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) accept([...input.files]);
    input.value = '';
  });
}
