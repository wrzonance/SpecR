// MCP chat sidebar — an LLM-backed assistant (OpenAI or Anthropic) that answers questions about
// the loaded specs/projects/libraries by calling SpecR's MCP tools.
//
// The browser holds NO API key. It POSTs the running conversation to the demo
// server's /chat endpoint (server.mjs), which owns the provider key, runs the
// tool-calling loop, and bridges each tool call to SpecR's POST /mcp. We
// render the final assistant message plus a small trace of which MCP tools ran.

import { renderMarkdownInto } from './render-markdown.mjs';

const CHAT_ENDPOINT = '/chat';
// Persist the running conversation so a page reload keeps context. The demo has
// no user identity or DB, so localStorage is the right layer. We keep the FULL
// transcript for display + persistence and send only a bounded recent window to
// the model each turn — mirroring WrzDJ's "full transcript vs. bounded model
// context" split (server hard-caps at 40 messages).
const STORAGE_KEY = 'specr-demo-chat-history';
const CONTEXT_WINDOW = 30;

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    );
  } catch {
    return []; // storage unavailable / corrupt — start clean
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage full/unavailable (e.g. private mode) — in-memory history still works.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function initChat(opts = {}) {
  const onFocus = typeof opts.onFocus === 'function' ? opts.onFocus : null;
  const toggle = document.getElementById('chat-toggle');
  const sidebar = document.getElementById('chat-sidebar');
  const closeBtn = document.getElementById('chat-close');
  const list = document.getElementById('chat-messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const clearBtn = document.getElementById('chat-clear');
  if (!toggle || !sidebar || !list || !form || !input) return;

  // Snapshot the seeded greeting nodes so "Clear" can restore a pristine sidebar
  // without an innerHTML round-trip (message bodies are always set via textContent).
  const seededNodes = Array.from(list.children, (node) => node.cloneNode(true));
  // Full conversation transcript (persisted across reloads). A bounded window of
  // this is what actually gets sent to the model (system prompt is server-owned).
  const history = loadHistory();
  let busy = false;

  function openSidebar() {
    sidebar.hidden = false;
    sidebar.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  function closeSidebar() {
    sidebar.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    // Keep it in the DOM but hide after the transition so re-open is instant.
    sidebar.hidden = true;
  }

  function scrollToEnd() {
    list.scrollTop = list.scrollHeight;
  }

  // `markdown` renders the text as sanitized markdown (assistant replies only — LLM
  // output). User input, the "Thinking…" placeholder, and error strings stay plain
  // textContent. renderMarkdownInto is the sole audited markup insertion point.
  function addBubble(role, text, { pending = false, markdown = false } = {}) {
    const bubble = el('div', `chat-bubble is-${role}${pending ? ' is-pending' : ''}`);
    bubble.appendChild(el('span', 'chat-role', role === 'user' ? 'YOU' : 'SpecR'));
    if (markdown) {
      const body = el('div', 'chat-text chat-markdown');
      renderMarkdownInto(body, text);
      bubble.appendChild(body);
    } else {
      bubble.appendChild(el('p', 'chat-text', text));
    }
    list.appendChild(bubble);
    scrollToEnd();
    return bubble;
  }

  function addToolTrace(bubble, toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
    const names = toolCalls.map((call) => `${call.name}${call.ok === false ? ' ⚠' : ''}`);
    bubble.appendChild(el('p', 'chat-tools', `⛭ ${names.join(' · ')}`));
  }

  async function send(text) {
    if (busy) return;
    busy = true;
    history.push({ role: 'user', content: text });
    saveHistory(history);
    addBubble('user', text);
    const pending = addBubble('assistant', 'Thinking…', { pending: true });
    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send only the recent window to the model; the full transcript stays local.
        body: JSON.stringify({ messages: history.slice(-CONTEXT_WINDOW) }),
      });
      const body = await res.json().catch(() => null);
      pending.remove();
      if (!body || body.success !== true) {
        const code = body?.code;
        const message =
          code === 'no-key'
            ? body?.error ||
              'Chat is not configured — set the selected provider key (OPENAI_API_KEY or ANTHROPIC_API_KEY) on the demo server.'
            : body?.error || `chat failed: ${res.status}`;
        addBubble('assistant', message);
        return;
      }
      const reply = body.data.reply || '(no response)';
      history.push({ role: 'assistant', content: reply });
      saveHistory(history);
      const bubble = addBubble('assistant', reply, { markdown: true });
      addToolTrace(bubble, body.data.toolCalls);
      const anchors = body.data.focus?.anchors;
      if (onFocus && Array.isArray(anchors) && anchors.length > 0) onFocus(anchors);
    } catch (err) {
      pending.remove();
      addBubble('assistant', `Could not reach the chat service: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  function clearConversation() {
    history.length = 0;
    saveHistory(history);
    // Restore the pristine greeting from cloned nodes (no innerHTML — XSS-safe).
    list.replaceChildren(...seededNodes.map((node) => node.cloneNode(true)));
    input.focus();
  }

  // Replay a persisted conversation so a reload keeps the context visible. Assistant
  // turns were markdown; user turns stay plain text.
  for (const message of history)
    addBubble(message.role, message.content, { markdown: message.role === 'assistant' });

  toggle.addEventListener('click', () => {
    if (sidebar.classList.contains('is-open')) closeSidebar();
    else openSidebar();
  });
  closeBtn?.addEventListener('click', closeSidebar);
  clearBtn?.addEventListener('click', clearConversation);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void send(text);
  });
}
