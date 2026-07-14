// Unit tests for the blob-download trigger (#477). Run:
//   node --test examples/web_ui_demo/download.test.mjs
// Outside CI (examples/ is not a vitest project) — no jsdom in this repo, so
// triggerBlobDownload takes its DOM/Blob-URL primitives as an injectable `deps`
// (mirrors scoring.js's sheet-parameter pattern). Pins the spike-found revoke
// race: revokeObjectURL must fire exactly once, on both success and failure,
// and never before link.click() has actually been dispatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerBlobDownload } from './js/download.js';

// A fake anchor + a fake deps object that logs every call (in order) so tests
// can assert both "did it happen" and "in what order" without a real DOM.
function fakeDeps({ clickThrows = false, appendThrows = false } = {}) {
  const calls = [];
  let scheduled = null;
  const link = {
    href: '',
    download: '',
    click() {
      calls.push('click');
      if (clickThrows) throw new Error('click failed');
    },
  };
  const deps = {
    createObjectURL(blob) {
      calls.push(['createObjectURL', blob]);
      return 'blob:fake-url';
    },
    revokeObjectURL(url) {
      calls.push(['revokeObjectURL', url]);
    },
    createAnchor() {
      calls.push('createAnchor');
      return link;
    },
    appendChild(el) {
      calls.push('appendChild');
      if (appendThrows) throw new Error('appendChild failed');
    },
    removeChild() {
      calls.push('removeChild');
    },
    scheduleRevoke(fn) {
      calls.push('scheduleRevoke');
      scheduled = fn;
    },
  };
  return { deps, calls, link, flush: () => scheduled?.() };
}

test('triggerBlobDownload: success — click is dispatched, revoke deferred until flushed, then fires exactly once', () => {
  const { deps, calls, link, flush } = fakeDeps();
  const blob = { size: 4 };

  triggerBlobDownload(blob, 'report.docx', deps);

  // The anchor was wired and clicked synchronously...
  assert.equal(link.href, 'blob:fake-url');
  assert.equal(link.download, 'report.docx');
  assert.ok(calls.includes('click'), 'click was dispatched');
  // ...but the revoke must NOT have run yet — only scheduled.
  assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === 'revokeObjectURL'));
  assert.ok(calls.includes('scheduleRevoke'));
  assert.ok(
    calls.indexOf('click') < calls.indexOf('scheduleRevoke'),
    'revoke must be scheduled no earlier than the click was dispatched'
  );

  flush();

  const revokes = calls.filter((c) => Array.isArray(c) && c[0] === 'revokeObjectURL');
  assert.deepEqual(revokes, [['revokeObjectURL', 'blob:fake-url']]);
});

test('triggerBlobDownload: failure after click (link.click throws) still revokes exactly once, after the click attempt', () => {
  const { deps, calls, flush } = fakeDeps({ clickThrows: true });
  const blob = { size: 4 };

  assert.throws(() => triggerBlobDownload(blob, 'report.docx', deps), /click failed/);

  assert.ok(calls.includes('click'), 'click was attempted before the throw');
  assert.ok(
    !calls.some((c) => Array.isArray(c) && c[0] === 'revokeObjectURL'),
    'not revoked synchronously'
  );
  assert.ok(
    calls.indexOf('click') < calls.indexOf('scheduleRevoke'),
    'revoke must still be scheduled no earlier than the click attempt'
  );

  flush();

  const revokes = calls.filter((c) => Array.isArray(c) && c[0] === 'revokeObjectURL');
  assert.deepEqual(revokes, [['revokeObjectURL', 'blob:fake-url']]);
});

test('triggerBlobDownload: failure before click (appendChild throws) still revokes exactly once, and click never fires', () => {
  const { deps, calls, flush } = fakeDeps({ appendThrows: true });
  const blob = { size: 4 };

  assert.throws(() => triggerBlobDownload(blob, 'report.docx', deps), /appendChild failed/);

  assert.ok(!calls.includes('click'), 'click was never dispatched');
  assert.ok(
    !calls.some((c) => Array.isArray(c) && c[0] === 'revokeObjectURL'),
    'not revoked synchronously'
  );

  flush();

  const revokes = calls.filter((c) => Array.isArray(c) && c[0] === 'revokeObjectURL');
  assert.deepEqual(revokes, [['revokeObjectURL', 'blob:fake-url']]);
});

test('triggerBlobDownload: scheduleRevoke is called exactly once per invocation (no double-revoke risk)', () => {
  const { deps, calls } = fakeDeps();
  triggerBlobDownload({ size: 1 }, 'x.docx', deps);
  assert.equal(calls.filter((c) => c === 'scheduleRevoke').length, 1);
});
