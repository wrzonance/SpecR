# ADR-034: PDF ingest libraries — text extractor + OCR path

## Status

Accepted

## Context

PDF is the most common format spec writers receive from manufacturers and
owners (#65). Adding a PDF adapter to the parser means picking two third-party
dependencies before any parsing code lands: a **PDF text extractor** and an
**OCR engine** for scanned, text-less PDFs. This ADR is slice 1/3 of #65 — the
dependency decision the two implementation slices (#245 extraction pipeline,
#246 normalization) build on. No library is added to `package.json` here; this
records *which* to add and *why*.

Constraints that shape the choice:

- **Headless, offline-capable, no GPU (ADR-002).** SpecR is a headless Node 22
  REST API. The extractor must run server-side with no browser/canvas/DOM, and
  the OCR path must work fully offline — no per-page cloud round-trip, no API
  key, no PII leaving the process. A spec PDF is client-confidential.
- **License hygiene (`security.md`).** Prefer MIT / Apache-2.0 / 0BSD; vet every
  candidate for known CVEs/advisories before adopting; treat the package manager
  itself as an attack surface (verify exact names, no typosquats).
- **ESM + bundle fit.** `"type": "module"`, strict TS, small footprint. The
  extractor should not drag in a native `canvas` build just to read a text layer.
- **Reuse over reinvention.** We already depend on `chardet` and `iconv-lite`
  (encoding detection/transcoding) for `.SEC`/DOCX — the font-encoding work in
  slices 2/3 reuses those, not a new dependency.

### Candidate text extractors

| Library | License | Latest (2026-06) | Maintained | Underlying engine | Native deps for text? |
|---|---|---|---|---|---|
| **unpdf** | MIT | 1.6.2 (2026-04) | active (unjs) | bundled serverless pdf.js | **none** |
| pdfjs-dist | Apache-2.0 | 6.0.227 (2026-05) | active (Mozilla) | pdf.js (itself) | none for text; canvas only to render |
| pdf-parse | Apache-2.0 | 2.4.5 (2025-10) | active (rewrite) | wraps `pdfjs-dist` + `@napi-rs/canvas` | pulls `@napi-rs/canvas` |
| pdf2json | Apache-2.0 | 4.0.3 (2026-04) | active (modesty) | forked/aged pdf.js internals | none |

### Candidate OCR paths

| Path | License | Latest | Maintained | Offline | Advisory |
|---|---|---|---|---|---|
| **tesseract.js** (WASM) | Apache-2.0 | 7.0.0 (2025-12) | active (naptha) | yes (local `.traineddata`) | clean at 7.x |
| native `tesseract` via `node-tesseract-ocr` | MIT (wrapper) | 2.2.1 (2021-05) | **abandoned** | yes | **CVE-2026-26832, unfixed** |
| cloud OCR (AWS Textract / Google Vision) | n/a (SaaS) | — | — | **no** | sends PII off-box |

## Decision

**Text extractor: `unpdf`** (MIT) as the primary, with **`pdfjs-dist`** (Apache-2.0)
as the lower-level fallback for malformed PDFs.
**OCR path: `tesseract.js`** (Apache-2.0, WASM), invoked only behind a "needs OCR"
gate. No native binary, no cloud OCR.

### 1. Primary extractor — `unpdf`

`unpdf` ships a serverless build of Mozilla's pdf.js, inlines the worker, and
**requires no native `canvas`** for text extraction — exactly the headless,
zero-native-dep fit ADR-002 wants. MIT, zero runtime dependencies, actively
maintained (last publish 2026-04), excellent TS types. Its `extractText({
mergePages })` returns both per-page text and a merged string in one call —
which directly feeds both the hierarchy pipeline (#64/#246) *and* the OCR gate
below (per-page char counts). `getMeta`, `extractImages`, and `renderPageAsImage`
cover the metadata and rasterization the OCR path needs (rasterization for OCR
does pull `@napi-rs/canvas`, isolated to the scanned-PDF branch — see §3).

### 2. Fallback extractor — `pdfjs-dist`

When `unpdf` throws or returns suspiciously little text on a structurally broken
PDF (corrupt xref, truncated object streams), slice 2 drops to `pdfjs-dist`
directly. It is the same engine `unpdf` wraps, but exposes the low-level
`getDocument`/`getTextContent` API with per-item transform/font data — needed for
the reading-order repair, header/footer stripping by position, and column
detection in #246, and for finer error recovery (`stopAtErrors: false`). Headless
text extraction via `getTextContent` needs **no** canvas/DOM (canvas is only for
`page.render`). Mozilla-maintained, current (6.0.227), Apache-2.0.

Two libraries, not one, is deliberate: `unpdf` is the clean fast path for the
common machine-generated PDF; `pdfjs-dist` is the escape hatch for the
pathological ones (#65 "graceful degradation: primary → fallback → partial result
with warnings → hard error"). They share an engine, so behavior is consistent and
the fallback adds no new parsing semantics — only more control.

### 3. OCR — `tesseract.js` (WASM), gated

Tesseract is the strongest open-source OCR for clean printed text (which is what
a scanned spec is) and the WASM port preserves the native engine's recognition
model unchanged. It runs **fully offline** from a locally-cached `.traineddata`
language model — no cloud, no API key, no client PDF leaving the box, satisfying
ADR-002 and the confidentiality constraint. Apache-2.0, actively maintained
(7.0.0, 2025-12). The OCR path runs **only** when the gate (§4) fires, so its
cost — a ~15 MB model download on first use, then per-page WASM latency — is paid
only on genuinely scanned input, never on the machine-generated common case. The
model is vendored/cached locally (not fetched per request) to keep the path
offline and deterministic.

### 4. "Needs OCR" detection heuristic

Decide per page from the extracted text layer, using `unpdf`'s per-page output:

> A PDF page needs OCR when its extracted text layer is **absent or yields fewer
> than `OCR_MIN_CHARS_PER_PAGE` (default 16) non-whitespace characters**. If
> **every** page is below threshold the document is treated as fully scanned; if
> only some pages are (mixed scan), OCR runs per-page on the empty ones and the
> result is spliced back in page order.

16 chars/page is a conservative floor — a real spec page carries hundreds of
characters; a scanned page yields 0 (no text stream) or a few stray glyphs from
embedded vector furniture. The threshold is a single tunable constant (validated
via the env Zod schema in slice 2), not a magic number scattered in code, so it
can be raised if a corpus proves it too low. Pages that trigger OCR are flagged
in the `warnings[]` of the `POST /parse` response (#65) so the caller knows the
text was machine-read, not extracted.

## Consequences

### Security vetting (per `security.md`)

Audited the chosen set (`unpdf` 1.6.2 + `pdfjs-dist` 6.0.227 + `tesseract.js`
7.0.0): **`npm audit` → 0 vulnerabilities.** Cross-validated independently
against the OSV.dev database (not just npm's feed). Findings:

- **`unpdf`** — no advisories. Clean.
- **`pdfjs-dist`** — historical **CVE-2024-4367** (GHSA-wgrm-67xf-hhpq, arbitrary
  JS execution from a malicious PDF) **fixed in 4.2.67**; our 6.x is well past it.
  The vector is the *interactive viewer / `eval`-style font path* — we extract
  text headlessly and never render or execute embedded JS — but we are patched
  regardless. Older CVE-2018-5158 fixed long ago (≤ 2.0.550).
- **`tesseract.js`** — historical GHSA-83rx-c8cr-6j8q (insecure default config)
  **fixed in 1.0.19**; our 7.x is unaffected.
- **Rejected** `node-tesseract-ocr` carries **CVE-2026-26832** (GHSA-8j44-735h-w4w2,
  OS command injection via an unsanitized `recognize()` parameter) with
  `last_affected = 2.2.1` — i.e. the latest published version, **no fix
  available** — on top of being abandoned since 2021. Disqualifying.

Licenses are all permissive (MIT / Apache-2.0), within `security.md`'s preference;
none copyleft. Exact package names verified against the npm registry and their
canonical GitHub repos (unjs/unpdf, mozilla/pdf.js, naptha/tesseract.js) to rule
out typosquats before any future install.

### Rejected alternatives

- **`pdf-parse` (as primary)** — its current 2.x rewrite is fine and Apache-2.0,
  but it wraps `pdfjs-dist` **and** hard-depends on `@napi-rs/canvas`, dragging a
  native build into the common text-only path that `unpdf` avoids entirely. We
  already get the same pdf.js engine via `unpdf`/`pdfjs-dist` without the native
  dep. (Its 1.x line is the genuinely-abandoned package the ecosystem warns about
  — a name worth not confusing with the rewrite.)
- **`pdf2json` (as primary)** — emits positional JSON, but on an older, forked
  pdf.js internal; the same positional data is available from `pdfjs-dist`'s
  maintained `getTextContent` transforms, which we already adopt as the fallback.
  No reason to add a second, staler engine.
- **Native `tesseract` binary via `node-tesseract-ocr`** — rejected on security
  (unfixed CVE-2026-26832, above) and operability: a native-binary wrapper means
  a system `tesseract` install as a deployment prerequisite, breaking the
  "clone-and-run headless" property. The WASM port keeps OCR self-contained.
- **Cloud OCR (AWS Textract / Google Document AI / Vision)** — higher accuracy on
  bad scans, but violates ADR-002's offline/headless stance and the
  confidentiality constraint (a client's spec PDF would leave the process to a
  third party), adds an API-key/credential surface and per-page cost, and creates
  a network dependency in the parse path. Out of scope; if a future corpus proves
  WASM Tesseract accuracy insufficient on low-DPI scans (a named risk in #65), a
  pluggable cloud-OCR adapter can be added behind the same gate — the gate (§4) is
  the stable seam, the engine behind it is swappable.

### Carried risks (named, not resolved here)

- **OCR accuracy on low-DPI scans** (#65 risk) — Tesseract wants ≥ 200 DPI clean
  contrast. Sub-threshold scans may misread section numbers/headers; slice 2/3
  surface low-confidence OCR pages via `warnings[]` rather than silently trusting
  them. The gate seam keeps a cloud upgrade open if needed.
- **Font-encoding corruption** — `unpdf`/`pdfjs-dist` map most glyphs correctly,
  but custom encoding vectors can still yield garbage. Detection/repair
  (frequency analysis, fingerprinting) is slice-2/3 work and reuses the existing
  `chardet`/`iconv-lite` deps — no new dependency for it.
- **First-run model download** — the ~15 MB Tesseract model is vendored/cached
  locally so the OCR path stays offline and deterministic across restarts.
