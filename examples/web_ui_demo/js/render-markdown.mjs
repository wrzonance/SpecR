// Shared, XSS-safe markdown renderer for the demo's two LLM-output surfaces:
// the Ask-SpecR chat bubbles (js/chat.js) and the Compose view's composed-report
// pane (js/compose.js). LLM output is UNTRUSTED input — a prompt-injected payload
// must render inert. This module owns the ENTIRE sanitization policy so it cannot
// drift between the two surfaces; it is the only place LLM text becomes markup.
//
// Policy (see render-markdown.test.mjs for the pinned adversarial cases):
//   • html:false — raw HTML in the source is ESCAPED to entities, never parsed.
//   • links — javascript:/vbscript:/file:/data: URLs are dropped (rendered as inert
//     text); every surviving <a> is forced to rel="noopener noreferrer" target="_blank".
//   • images — reduced to their escaped alt text: no <img> element and no image URL
//     ever reaches the DOM (a remote image in LLM output is a tracking/exfil channel).
//   • code — fenced and inline code render as escaped monospace (no highlighting).
//
// createMarkdownRenderer(MarkdownIt) is pure (string -> string) and is what the unit
// tests exercise by importing markdown-it straight from node_modules. In the browser
// the markdown-it UMD bundle is served at /vendor/markdown-it.min.js (see server.mjs)
// and exposes window.markdownit; renderMarkdown() lazily wraps that global and
// renderMarkdownInto() is the single audited innerHTML insertion point.

const UNSAFE_SCHEME = /^(?:vbscript|javascript|file|data):/;

// Reject dangerous URL schemes; allow everything else (http/https/mailto and
// scheme-less relative/anchor links). ASCII whitespace and control characters
// (tab, newline, etc.) are stripped first so an obfuscated scheme like
// "java\tscript:" cannot slip past the test.
function isSafeLink(url) {
  const normalized = String(url)
    .replace(/[\u0000-\u0020]+/g, '')
    .toLowerCase();
  return !UNSAFE_SCHEME.test(normalized);
}

export function createMarkdownRenderer(MarkdownIt) {
  const md = new MarkdownIt({
    html: false, // raw HTML in the source is escaped, never rendered
    linkify: true, // turn bare URLs into links (still scheme-checked below)
    breaks: false, // CommonMark: a single newline is a soft break, not <br>
  });

  // Scheme allowlist. When this returns false markdown-it drops the link and renders
  // the link text as plain text — the href never reaches the DOM.
  md.validateLink = isSafeLink;

  // Force safe attributes on every rendered anchor.
  const renderToken = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
  const baseLinkOpen = md.renderer.rules.link_open || renderToken;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return baseLinkOpen(tokens, idx, options, env, self);
  };

  // Images are disabled as an active surface: render only the escaped alt text so no
  // <img> element and no image URL ever enters the DOM.
  md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content || '');

  return {
    render(source) {
      return md.render(typeof source === 'string' ? source : '');
    },
  };
}

// Minimal HTML escape for the degraded path (the vendor script failed to load): the
// text still renders inert rather than as live markup.
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let cachedRenderer;
function activeRenderer() {
  if (cachedRenderer === undefined) {
    const MarkdownIt = globalThis.markdownit;
    cachedRenderer = typeof MarkdownIt === 'function' ? createMarkdownRenderer(MarkdownIt) : null;
  }
  return cachedRenderer;
}

// Render untrusted markdown to a string of inert HTML. Lazily binds to the browser's
// window.markdownit (served from /vendor) on first call, so importing this module in
// Node (for the unit tests) never touches the global.
export function renderMarkdown(source) {
  const renderer = activeRenderer();
  return renderer ? renderer.render(source) : escapeHtml(String(source ?? ''));
}

// The single audited insertion point: the ONLY place LLM text becomes DOM markup.
// renderMarkdown guarantees the string is inert, so innerHTML is safe here.
export function renderMarkdownInto(element, source) {
  element.innerHTML = renderMarkdown(source);
}
