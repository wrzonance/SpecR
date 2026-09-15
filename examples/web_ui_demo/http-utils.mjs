// examples/web_ui_demo/http-utils.mjs
// Small, dependency-free HTTP helpers shared by server.mjs and its route
// handlers (chat-handler.mjs, report-handler.mjs). Kept framework-free — the
// demo server is plain node:http, no Express.

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

// Like readRequestBody, but stops accumulating and throws once `maxBytes` is
// crossed — so an oversized body can't be fully buffered into memory before
// it is rejected. Used by /report (small JSON envelopes only).
export async function readBoundedBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

// Build the upstream URL for a proxied API request. The request's path and
// query are copied onto a URL constructed from `apiBase` alone — assigning
// `pathname`/`search` on a parsed URL can never change its scheme, host or
// port, whereas `new URL(pathname, apiBase)` would treat a path beginning with
// `//` (e.g. from `/specs/..//evil.example/x`) as a scheme-relative URL and
// retarget the whole request at another host. The API-prefix allowlist in
// server.mjs already keeps such paths out of the proxy; this makes the proxy
// safe even without it (CodeQL js/request-forgery).
export function upstreamUrl(apiBase, pathname, search = '') {
  const target = new URL(apiBase);
  target.pathname = pathname;
  target.search = search;
  target.hash = '';
  return target;
}
