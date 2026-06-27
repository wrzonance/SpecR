# ADR-039: Offline OCR provisioning — bounded worker init + local traineddata

## Status

Accepted

## Context

ADR-034 chose `tesseract.js` (WASM, Apache-2.0) for the scanned-PDF OCR path and
stated the language model "is vendored/cached locally (not fetched per request)
to keep the path offline and deterministic." The implementation (#246/#290)
initializes the worker with `Tesseract.createWorker('eng', 1, …)`. The
provisioning detail ADR-034 asserted was never actually *enforced* in code, which
left two offline failure modes (#298):

1. **Fail-fast (already handled, #290).** When the model cache is empty **and**
   `OCR_LANG_PATH` is unset, `tesseract.js` falls back to fetching
   `eng.traineddata` from a CDN on first use. If that fetch *rejects*
   (`TypeError: fetch failed`), #290 converts the typed `ParserError` into a clean
   `pdf-ocr-unusable` warning — the parse completes.

2. **Indefinite stall (was NOT handled).** If the network *accepts the connection
   but never responds* (a black-hole proxy, a hung TLS handshake, a captive
   portal), `createWorker` neither resolves nor rejects. `recognizePdfPages` —
   and therefore the whole parse job — hangs forever. There was no bounded init
   timeout on the production path, so a single scanned upload in a
   network-restricted environment could wedge a Piscina worker thread
   indefinitely.

The core invariant we need: **a scanned PDF in an offline / uncached /
unconfigured environment must complete with a `pdf-ocr-unusable` warning within a
bounded time — never an indefinitely-stuck parse job** — without regressing the
#290 fail-fast path, and without OCR depending on an outbound CDN fetch in
production.

The issue floated three complementary options: a bounded init timeout, requiring
local `eng.traineddata`, and a pre-flight availability check.

## Decision

Adopt the **bounded init timeout** as the load-bearing fix, and codify
**local-traineddata provisioning** as the documented production requirement. The
pre-flight check is deliberately *not* added (see Rejected alternatives).

### 1. Bounded worker initialization (the spine)

Wrap OCR worker creation in `src/parser/pdf/ocr.ts` in a `Promise.race` against a
timer:

- A new `initManagedRecognizer(options)` races the worker factory against
  `setTimeout(…, OCR_INIT_TIMEOUT_MS)`. On timeout it rejects with a typed
  `ParserError` (`OCR worker init exceeded <n>ms timeout`). The timer is cleared
  in a `finally` so a fast init never leaves a dangling handle.
- The timeout is the **only** thing added to the hot path; recognition of each
  rendered page is left unbounded by this knob because the hang is specifically in
  *init* (model acquisition), not per-page recognize, which already resolves or
  rejects.
- `OCR_INIT_TIMEOUT_MS` is a Zod-validated env knob (`src/lib/env.ts`, positive
  integer, **default 30000**), threaded through `parse-worker.ts` →
  `ParseOptions.ocrInitTimeoutMs` → `PdfOcrOptions.initTimeoutMs`. It is overridable
  per deployment.
- A `ParserError` from init (timeout **or** the #290 fetch rejection) is caught by
  the existing `applyOcrIfNeeded` handler in `src/parser/pdf/index.ts` and degrades
  to a `pdf-ocr-unusable` warning. The #290 fail-fast is preserved: any factory
  rejection is wrapped as `ParserError` at the same init boundary.

**Worker-leak safety on timeout.** A `createWorker` that loses the race may still
resolve *later* (the stalled CDN fetch eventually completes). `terminateLater()`
attaches a continuation that terminates such a late-arriving worker, so a
timed-out attempt never leaks a Tesseract worker process. A late *rejection* is
already covered by the degradation and is swallowed.

A DI seam (`PdfOcrOptions.createWorker`, mirroring the existing
`renderPageAsImage` / `recognize` seams) lets the bounded-timeout invariant be
unit-tested by simulating a never-resolving init — **no network and no real
traineddata required**, so the regression test runs in the default offline unit
suite.

### 2. Local traineddata is the production provisioning model

**Production OCR must not depend on an outbound CDN fetch.** The supported
provisioning is to vendor `eng.traineddata` (Apache-2.0, same license as the
engine) onto the box and point `OCR_LANG_PATH` at its directory (or pre-warm
`OCR_CACHE_PATH`). `.env.example` documents this as the production requirement and
explains that an unset `OCR_LANG_PATH` with an empty cache is what triggers the
CDN fallback. The bounded timeout in §1 is the *safety net* for when this is
misconfigured; local traineddata is the *intended steady state*.

We do **not** check a binary `eng.traineddata` into this repo. It is an
ops/deployment artifact (≈15 MB), not source; committing it would bloat the repo
and couple the language set to the code. The requirement is documented and
enforced operationally, with the timeout guaranteeing graceful degradation if it
is missed.

## Consequences

- A scanned PDF in an offline/uncached/unconfigured environment now **always**
  terminates within `OCR_INIT_TIMEOUT_MS` (default 30s) with a `pdf-ocr-unusable`
  warning, instead of hanging a worker thread. Pinned by a regression test named
  for the symptom (`ocr: worker init stall degrades to pdf-ocr-unusable within
  timeout, never hangs`).
- The #290 fail-fast behavior is unchanged; both the fetch-rejection and the
  new stall case funnel through the same `ParserError` → `pdf-ocr-unusable` path.
- A correctly provisioned deployment (vendored traineddata via `OCR_LANG_PATH`)
  never reaches a CDN, so the timeout is effectively dormant there — it only ever
  fires on a misconfiguration, which is exactly when we want graceful degradation.
- New tunable `OCR_INIT_TIMEOUT_MS`. Default 30s is generous enough that a slow
  but working init (cold WASM compile + large model load from local disk) is not
  cut off, while still bounding a true stall.
- The `createWorker` DI seam slightly widens the OCR module's public option
  surface, but consistently with the seams already used for testing render and
  recognize.

### Rejected alternatives

- **Pre-flight traineddata availability check.** Statically stat-ing the cache /
  `langPath` before invoking OCR was considered but rejected: it duplicates
  tesseract.js's own resolution logic (cache dir, `langPath`, gzip vs raw,
  per-language filenames), risks drifting from it across upstream versions, and
  cannot cover the very failure this ADR targets — a path that *exists* but whose
  fetch *stalls*. The bounded timeout subsumes every "model not readily available"
  case (absent, unreadable, or hung) with one mechanism, so a pre-flight check
  would add surface area without closing a gap the timeout leaves open.
- **Committing `eng.traineddata` to the repo.** Rejected as repo bloat and a
  source/artifact boundary violation; provisioning is an ops concern (see §2).
- **Bounding per-page `recognize` with the same knob.** Not done — the observed
  hang is in init/model acquisition; per-page recognition already settles. Adding
  a recognize timeout would be scope the issue does not call for (YAGNI) and could
  truncate a slow-but-valid page.
