// Triggers a browser "Save As" for an in-memory Blob via a throwaway
// <a download> element (#477 — the header/footer "Download DOCX" action).
//
// The DOM/Blob-URL primitives are injected as `deps` (default: real
// document/URL/setTimeout) so this is boundary-testable without jsdom —
// mirrors scoring.js's sheet-parameter pattern used elsewhere in this demo.
const browserDeps = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  createAnchor: () => document.createElement('a'),
  appendChild: (el) => document.body.appendChild(el),
  removeChild: (el) => document.body.removeChild(el),
  scheduleRevoke: (fn) => setTimeout(fn, 0),
};

// Revoking the object URL synchronously right after link.click() is a
// plausible (if usually-benign-in-Chrome) race with the browser's own
// download/navigation start for larger blobs — deferring the revoke by one
// macrotask guarantees it never runs before the click has been dispatched,
// on both the success and failure path (the `finally` always schedules it
// exactly once).
//
// `link.click()` throwing must not skip detaching the anchor — `removeChild`
// used to sit inline after `click()` in the try block, so a throwing click
// left the throwaway element permanently attached to document.body. It now
// runs from `finally`, guarded by `attached` so it's never called on a link
// `appendChild` itself failed to attach (that would throw its own
// NotFoundError against a real DOM).
export function triggerBlobDownload(blob, filename, deps = browserDeps) {
  const url = deps.createObjectURL(blob);
  const link = deps.createAnchor();
  link.href = url;
  link.download = filename;
  let attached = false;
  try {
    deps.appendChild(link);
    attached = true;
    link.click();
  } finally {
    if (attached) deps.removeChild(link);
    deps.scheduleRevoke(() => deps.revokeObjectURL(url));
  }
}
