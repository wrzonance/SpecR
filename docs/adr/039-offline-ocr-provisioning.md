# ADR-039: Offline OCR provisioning — bounded init timeout + strict-offline pre-flight

## Status

Accepted. Revised after a Codex (GPT-5.5, xhigh) adversarial review of PR #311
found a real worker leak the original timeout-only decision did not close — see
"Revision: the leak the timeout cannot fix" below.

## Context

ADR-034 chose `tesseract.js` (WASM, Apache-2.0) for the scanned-PDF OCR path and
stated the language model "is vendored/cached locally (not fetched per request)
to keep the path offline and deterministic." The implementation (#246/#290)
initializes the worker with `Tesseract.createWorker('eng', 1, …)`. The
provisioning detail ADR-034 asserted was never actually *enforced* in code, which
left these offline failure modes (#298):

1. **Fail-fast (already handled, #290).** When the model cache is empty **and**
   `OCR_LANG_PATH` is unset, `tesseract.js` falls back to fetching
   `eng.traineddata` from a CDN on first use. If that fetch *rejects*
   (`TypeError: fetch failed`), #290 converts the typed `ParserError` into a clean
   `pdf-ocr-unusable` warning — the parse completes.

2. **Indefinite stall (the hang).** If the network *accepts the connection but
   never responds* (a black-hole proxy, a hung TLS handshake, a captive portal),
   `createWorker` neither resolves nor rejects. `recognizePdfPages` — and
   therefore the whole parse job — hangs forever. There was no bounded init
   timeout, so a single scanned upload in a network-restricted environment could
   wedge a Piscina worker thread indefinitely.

3. **Worker leak in that same stall (found by the PR #311 review).** In
   tesseract.js v7, `createWorker` calls `spawnWorker()` **synchronously, before**
   the `loadLanguage` job that fetches the traineddata. So in the black-hole stall
   of mode 2 the worker thread is *already alive* while `createWorker` never
   settles. A bounded timeout makes the parse job return, but the orphaned worker
   is never terminated (there is no handle to it until `createWorker` resolves).
   Repeated scanned PDFs accumulate stuck workers.

The core invariant: **a scanned PDF in an offline / uncached / unconfigured
environment must complete with a `pdf-ocr-unusable` warning within a bounded
time, never hang, AND never leak a worker** — without regressing the #290
fail-fast path, and without OCR depending on an outbound CDN fetch in production.

A hard constraint shapes the fix: **preserve the convenient networked-dev
default.** A dev machine with working network should still fetch `eng.traineddata`
from the CDN on first run. So "refuse whenever no local traineddata" cannot be the
default — it must be opt-in.

## Decision

The hang and the leak are **different problems needing complementary mechanisms**:

- a **bounded init timeout** stops the *hang* (parse always returns), and
- a **strict-offline pre-flight** stops the *leak* (never spawn a worker that
  would black-hole), gated behind an opt-in flag so the dev default is untouched.

Plus **local-traineddata provisioning** as the documented production requirement.

### 1. Bounded worker initialization — stops the hang

`initManagedRecognizer(options)` in `src/parser/pdf/ocr.ts` races the worker
factory against `setTimeout(…, OCR_INIT_TIMEOUT_MS)`. On timeout it rejects with a
typed `ParserError`; the timer is cleared in a `finally`. The existing
`applyOcrIfNeeded` handler degrades any init `ParserError` (timeout **or** the
#290 fetch rejection) to a `pdf-ocr-unusable` warning, so the #290 fail-fast is
preserved. `OCR_INIT_TIMEOUT_MS` is a Zod-validated env knob (positive int,
**default 30000**), threaded `parse-worker.ts → ParseOptions.ocrInitTimeoutMs →
PdfOcrOptions.initTimeoutMs`. The timeout is the only thing added to the hot path;
per-page `recognize` is left unbounded (it already settles).

`terminateLater()` terminates a worker that resolves *after* the timeout fired —
e.g. a stalled fetch that eventually completes. **This does not cover the
black-hole case** (mode 3): if `createWorker` never settles, `terminateLater`'s
continuation never runs and the already-spawned worker leaks. That gap is closed
by §3, not here.

### 2. Local traineddata is the production provisioning model

**Production OCR must not depend on an outbound CDN fetch.** Vendor
`eng.traineddata` (Apache-2.0, same license as the engine) onto the box and point
`OCR_LANG_PATH` at its directory (or pre-warm `OCR_CACHE_PATH`). We do **not**
commit the binary (~15 MB) to the repo — it is an ops/deployment artifact, not
source. The requirement is documented in `.env.example`.

### 3. Strict-offline pre-flight — stops the leak (opt-in)

A new env flag **`OCR_REQUIRE_LOCAL_TRAINEDDATA`** (`z.stringbool()`, **default
false**) turns on strict mode. When enabled, `assertLocalTraineddataIfRequired`
runs **before** any worker is spawned: if no local traineddata exists, it throws a
`ParserError` (degrading to `pdf-ocr-unusable`) **without invoking the worker
factory** — so an offline box never spawns a worker that would black-hole and
leak. When local data *is* present, OCR proceeds normally with the §1 timeout as
the safety net for a "data present but init still stalls" case.

The pre-flight (`hasLocalTraineddata`) probes both the plain and gzipped names in
both the `langPath` and `cachePath` directories, matching tesseract.js v7's actual
resolution: it reads its cache as `${cachePath}/${lang}.traineddata` and a local
`langPath` as `${langPath}/${lang}.traineddata[.gz]`. A URL `langPath` simply does
not stat, so it is correctly treated as "not local". The filename contract is
pinned by a unit test against a temp dir, so drift from tesseract.js (the original
reason this was rejected) is caught by CI rather than assumed away.

**Default false preserves the dev default**: with strict mode off, behavior is
exactly mode-1/mode-2 (may fetch from CDN on first run, bounded by the timeout).
The rare black-hole leak is accepted there as the cost of dev convenience.
**Production sets `OCR_REQUIRE_LOCAL_TRAINEDDATA=true`** and provisions local data
(§2), so it never spawns a CDN-bound worker and never leaks.

Two test seams keep this fully offline-testable, mirroring the existing
`renderPageAsImage` / `recognize` / `createWorker` seams: `requireLocalTraineddata`
and an injectable `hasLocalTraineddata` check.

## Consequences

- A scanned PDF offline now **always** returns within `OCR_INIT_TIMEOUT_MS`
  (default 30s) with a `pdf-ocr-unusable` warning. In strict offline mode it
  additionally **never spawns a worker** when local data is absent — no hang, no
  leak. Pinned by regression tests named for the symptoms:
  `'ocr: worker init stall degrades to pdf-ocr-unusable within timeout, never
  hangs'` and `'ocr: offline with no local traineddata → degrades to
  pdf-ocr-unusable WITHOUT spawning a worker (no leak)'` (asserts the worker
  factory is never invoked).
- The #290 fail-fast is unchanged; fetch-rejection, stall, and strict-mode refusal
  all funnel through the same `ParserError` → `pdf-ocr-unusable` path.
- Two new tunables: `OCR_INIT_TIMEOUT_MS` (default 30000) and
  `OCR_REQUIRE_LOCAL_TRAINEDDATA` (default false). The default preserves the
  dev-friendly CDN-on-first-run behavior; production enables strict mode.
- `PdfOcrOptions` gains `initTimeoutMs`, `createWorker`, `requireLocalTraineddata`,
  and `hasLocalTraineddata` — a slightly wider option surface, consistent with the
  DI seams already used for render/recognize testing.
- The pre-flight reads tesseract.js's cache-filename convention. If a future
  tesseract.js major changes that filename, the pinned filename test fails in CI,
  flagging the needed update rather than silently mis-detecting.

### Rejected alternatives

- **Timeout *instead of* pre-flight (the original PR #311 decision).** Rejected by
  the Codex review: the timeout stops the hang but not the leak, because the worker
  is spawned before the fetch. Timeout and pre-flight are complementary, not
  substitutes — both are adopted.
- **Strict pre-flight as the default.** Rejected: it would break the convenient
  networked-dev path (no CDN fetch on first run). Strict mode is opt-in.
- **Committing `eng.traineddata` to the repo.** Rejected as repo bloat and a
  source/artifact boundary violation; provisioning is an ops concern (§2).
- **Bounding per-page `recognize` with the same knob.** Not done — the hang is in
  init/model acquisition; per-page recognition already settles (YAGNI).

### Revision: the leak the timeout cannot fix

The first version of this ADR (shipped in PR #311) adopted the bounded timeout and
**rejected** a pre-flight check, arguing the timeout "subsumes every model-not-
readily-available case." A **Codex (GPT-5.5, xhigh) adversarial review of PR #311**
showed that reasoning was wrong for the *leak*: because tesseract.js spawns the
worker synchronously before fetching the model, a black-hole stall leaves a live
worker the timeout can never terminate. This revision corrects the record —
pre-flight (§3) and timeout (§1) are complementary — and credits that review.
