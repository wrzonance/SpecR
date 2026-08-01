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
