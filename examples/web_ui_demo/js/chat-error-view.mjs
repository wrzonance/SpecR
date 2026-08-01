// examples/web_ui_demo/js/chat-error-view.mjs
// Error bubbles are built here so they can be unit-tested without a browser.
// Everything is createElement + textContent: an error string may contain a raw
// provider body, which must never be parsed as markup.
//
// Its own module because js/chat.js imports ./render-markdown.mjs at load time,
// so importing chat.js from a `node --test` file would execute browser-targeted
// code with no DOM present. A dependency-free module keeps the builder
// importable under Node without a DOM shim for the whole chat module.
export function buildErrorBubble(doc, { error, code, detail }) {
  const bubble = doc.createElement('div');
  bubble.className = 'chat-bubble is-assistant is-error';

  const role = doc.createElement('span');
  role.className = 'chat-role';
  role.textContent = 'SpecR';
  bubble.appendChild(role);

  const body = doc.createElement('p');
  body.className = 'chat-text';
  body.textContent = error;
  bubble.appendChild(body);

  // Technical detail stays one click away rather than front-loaded — the same
  // progressive disclosure the rest of the UI uses for OOXML internals.
  if (detail) {
    const details = doc.createElement('details');
    details.className = 'chat-error-detail';
    const summary = doc.createElement('summary');
    summary.textContent = code ? `Technical detail (${code})` : 'Technical detail';
    details.appendChild(summary);
    const pre = doc.createElement('pre');
    pre.textContent = detail;
    details.appendChild(pre);
    bubble.appendChild(details);
  }
  return bubble;
}
