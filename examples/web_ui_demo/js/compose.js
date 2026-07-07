// Compose view — agent-driven grounded reporting (#353).
//
// The browser holds NO API key. It POSTs a report request to the demo server's
// /report endpoint (server.mjs), which runs a READ-ONLY OpenAI tool-calling loop
// over SpecR's MCP tools and streams newline-delimited JSON events back: one
// `step` per grounded tool call (running → done/error), periodic `usage`, and a
// final `done` carrying the composed narrative plus deterministic citations.
//
// We render the steps live (so the grounding is visible), the narrative, and a
// click-through Sources list — every citation traces to a real paragraph UUID and
// opens it in the Report/audit view. Facts come from the tools; only the prose
// varies between runs, so "Regenerate" demonstrates reproducibility.

const REPORT_ENDPOINT = '/report';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Read a fetch response body as a stream of newline-delimited JSON objects,
// invoking `onEvent` for each parsed line. Tolerates chunk boundaries mid-line.
async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(safeParse(line));
    }
  }
  // Flush any bytes the streaming decoder was still holding (a multi-byte char
  // split across the final chunk boundary), then emit the trailing line.
  buf += decoder.decode();
  const tail = buf.trim();
  if (tail) onEvent(safeParse(tail));
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: 'error', error: 'malformed stream line' };
  }
}

export function initCompose(opts = {}) {
  const getScopeLabel = typeof opts.getScopeLabel === 'function' ? opts.getScopeLabel : () => '';
  const onCite = typeof opts.onCite === 'function' ? opts.onCite : null;
  const displaySection = typeof opts.displaySection === 'function' ? opts.displaySection : (s) => s;

  const scopeEl = document.getElementById('compose-scope');
  const input = document.getElementById('compose-input');
  const runBtn = document.getElementById('compose-run');
  const regenBtn = document.getElementById('compose-regenerate');
  const meterEl = document.getElementById('compose-meter');
  const stepsEl = document.getElementById('compose-steps');
  const outputEl = document.getElementById('compose-output');
  const examples = document.getElementById('compose-examples');
  if (!input || !runBtn || !stepsEl || !outputEl) return { refresh() {} };

  let busy = false;
  let lastRequest = '';
  const stepRows = new Map(); // step number -> <li>

  function refresh() {
    if (scopeEl) scopeEl.textContent = `Scope — ${getScopeLabel() || 'nothing loaded yet'}`;
  }

  function resetPanes() {
    stepRows.clear();
    stepsEl.replaceChildren();
    outputEl.replaceChildren();
    if (meterEl) {
      meterEl.hidden = true;
      meterEl.textContent = '';
    }
  }

  function renderStep(evt) {
    let row = stepRows.get(evt.n);
    if (!row) {
      row = el('li', 'compose-step');
      row.appendChild(el('span', 'compose-step-dot'));
      row.appendChild(el('span', 'compose-step-label', evt.label || evt.tool));
      stepRows.set(evt.n, row);
      stepsEl.appendChild(row);
    }
    row.classList.toggle('is-done', evt.status === 'done');
    row.classList.toggle('is-error', evt.status === 'error');
  }

  function renderUsage(evt) {
    if (!meterEl) return;
    meterEl.hidden = false;
    meterEl.textContent = `${evt.rounds} round(s) · ${evt.toolCalls} grounded call(s) · ~${evt.tokens.toLocaleString()} tokens`;
  }

  function renderCitations(citations) {
    if (!Array.isArray(citations) || citations.length === 0) return;
    const box = el('div', 'compose-sources');
    box.appendChild(el('h4', 'compose-sources-head', `Sources (${citations.length})`));
    const list = el('div', 'compose-source-list');
    for (const anchor of citations) list.appendChild(citationChip(anchor));
    box.appendChild(list);
    outputEl.appendChild(box);
  }

  function citationChip(anchor) {
    const label = displaySection(anchor.section);
    const chip = el('button', 'compose-cite', anchor.paragraphId ? `${label} ¶` : label);
    chip.type = 'button';
    chip.title = anchor.paragraphId ? 'Open the cited paragraph' : 'Open the cited section';
    if (onCite) chip.addEventListener('click', () => onCite(anchor));
    return chip;
  }

  function renderDone(evt) {
    outputEl.replaceChildren();
    outputEl.appendChild(el('div', 'compose-report-text', evt.reply || '(no narrative)'));
    renderCitations(evt.citations);
    regenBtn.hidden = false;
  }

  function renderError(evt) {
    const message =
      evt.code === 'no-key'
        ? 'Compose is not configured — set OPENAI_API_KEY on the demo server (server.mjs) to enable it.'
        : evt.error || 'report failed';
    outputEl.appendChild(el('p', 'compose-error', message));
  }

  function dispatch(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    if (evt.type === 'step') renderStep(evt);
    else if (evt.type === 'usage') renderUsage(evt);
    else if (evt.type === 'done') renderDone(evt);
    else if (evt.type === 'error') renderError(evt);
  }

  async function run(request) {
    if (busy || !request) return;
    busy = true;
    lastRequest = request;
    runBtn.disabled = true;
    runBtn.textContent = 'Composing…';
    regenBtn.hidden = true;
    resetPanes();
    try {
      const response = await fetch(REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request, scope: { label: getScopeLabel() } }),
      });
      await readNdjson(response, dispatch);
    } catch (err) {
      renderError({ error: `could not reach the report service: ${err.message}` });
    } finally {
      busy = false;
      runBtn.disabled = false;
      runBtn.textContent = 'Compose report';
    }
  }

  runBtn.addEventListener('click', () => void run(input.value.trim()));
  regenBtn?.addEventListener('click', () => void run(lastRequest));
  examples?.addEventListener('click', (event) => {
    const chip = event.target.closest?.('[data-example]');
    if (!chip) return;
    input.value = chip.dataset.example;
    input.focus();
  });

  // Pre-fill the request box from another view (the Compare → Compose handoff,
  // #385) and focus it, so the user only has to press "Compose report".
  function prefill(text) {
    if (typeof text !== 'string') return;
    input.value = text;
    input.focus();
  }

  refresh();
  return { refresh, prefill };
}
