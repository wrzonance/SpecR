# tools/verify — docx-preview visual round-trip verification harness

Agent-driven tool for issue [#150](https://github.com/wrzonance/SpecR/issues/150): renders a
reference DOCX and its round-tripped output (real upload → parse → template-import → generate,
through the actual SpecR REST API — never an in-process shortcut) side by side in the browser via
[docx-preview](https://github.com/VolodymyrBaydalka/docxjs), then pixel-diffs the two renders
region by region (page / header / footer) so drift is visible and attributable.

This is a development/verification tool, not part of the shipped product. It is an **isolated pnpm
package** — see [Isolation](#isolation-from-the-root-workspace) — and has zero runtime dependency on
`src/`.

## What it answers

Round-tripping a DOCX through SpecR's parser → AST → generator can silently change how the document
*looks* even when the AST round-trips correctly (a style default resolved differently, a page-size
mismatch, a lost run property). This harness makes that visible: upload a reference file, let it
round-trip through the real API, render both files with the same tool, and diff them.

## Quickstart

```bash
# 1. Install (isolated from the repo root — see Isolation below)
pnpm --dir tools/verify install

# 2. Configure (copy and edit if your API/DB run on non-default ports)
cp tools/verify/.env.example tools/verify/.env

# 3. Have a real SpecR API + Postgres running (this harness never mocks the API)
docker compose up -d postgres
pnpm migrate && pnpm seed
pnpm dev   # the main SpecR API, default http://localhost:3000

# 4. Start the harness itself (separate terminal)
pnpm --dir tools/verify dev   # http://localhost:4300 by default
```

Open the harness URL, upload a `.docx`, and watch the run progress. The page renders both panes as
soon as their files exist — but see [Driving a run](#driving-a-run-the-agent-workflow) for why
*screenshotting and diffing* the panes needs an external driving agent, not just the browser tab.

## Environment

See `.env.example` for the authoritative list; `src/config.ts`'s `loadVerifyEnv` validates all of it
with Zod and fails fast (never a silent default for `SPECR_API_BASE_URL`, which is required).

| Var | Default | Meaning |
|---|---|---|
| `SPECR_API_BASE_URL` | *(required)* | Base URL of the real SpecR REST API this harness drives. |
| `VERIFY_VIEWPORT_WIDTH` | `3200` | Required capture viewport width in px — see [finding 7](#7-viewport-width-must-fit-both-panes-not-just-be-pinned-task-8). |
| `VERIFY_PORT` | `4300` | Port this harness's own Express server listens on. |

## HTTP API

All routes are this package's own server (`src/server/app.ts`) — entirely separate from the main
SpecR API and from `openapi.yaml`, which needs no changes for this tool (see
[openapi.yaml](#openapiyaml-no-op)).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/runs` | Start a run: multipart `file` (the reference `.docx`) plus optional `section`/`title` fields. Returns `{ runId }` (202) immediately; the pipeline (upload → parse → import → generate) runs in the background. |
| `GET` | `/api/runs/:runId` | Poll a run's current `RunRecord` — `stage`, `status`, `artifacts`, and `error` if failed. |
| `POST` | `/api/runs/:runId/screenshot` | Ingest an externally-captured screenshot: JSON body `{ pane: 'reference'\|'roundtrip', imageBase64 }`. **This is the primary, and only, capture-ingestion path** — see [finding 2](#2-capture-source-external-playwright-screenshot-only). |
| `GET` | `/api/runs/:runId/files/:filename` | Serve one of a run's artifacts. `:filename` is a closed enum (`src/server/routes/files.ts`'s `RUN_FILE_NAMES`) — `reference.docx`, `generated.docx`, both screenshots, and the nine region crop/diff PNGs (`page-`/`header-`/`footer-` × `reference`/`roundtrip`/`diff`). |

## Driving a run (the agent workflow)

The harness page (`public/index.html` + `public/harness.js`) renders both panes and displays
whatever diff images already exist — it does **not** itself capture screenshots or compute diffs.
Per design decision 2 (below), doing that requires an external driving agent (Playwright, or this
session's Playwright MCP tools) because the harness's in-page rasterization attempt was proven
non-viable. The full, verified recipe (this is exactly the sequence the task-8 manual smoke test
ran, end to end, against a real API + Postgres):

1. **Start a run.** `POST /api/runs` with the reference `.docx` (or use the page's own upload
   form). Poll `GET /api/runs/:runId` until `stage: "generate", status: "complete"`.
2. **Pin the viewport before anything else.** Resize the browser to
   `>= VERIFY_VIEWPORT_WIDTH` (3200px default) and scroll to the top. `window.__harnessConfig.viewportWidth`
   on the page mirrors the server's configured value, so a driving script never has to hardcode it
   twice. This is not optional cosmetic advice — see finding 7.
3. **Load both panes** (the page's own poll loop does this automatically once `reference.docx`/
   `generated.docx` exist — `window.__loadPane('reference' | 'roundtrip')` if driving it manually).
4. **Measure geometry** via `window.__measure(pane)` / `window.__regionGeom(pane, region, pageIndex)`.
   These are `getBoundingClientRect()`-based and therefore **viewport-relative, not
   document-relative** — see finding 3.
5. **Capture and ingest a screenshot per pane.** Take a screenshot of that pane's content element
   (or the full page) and `POST` it as base64 PNG to `/api/runs/:runId/screenshot` with
   `{ pane, imageBase64 }`.
6. **Crop and diff each region using each pane's OWN geometry**, then feed the crops to
   `createPixelDiffer().diff()` — see finding 8 for why this must be per-pane geometry, not a single
   shared rect, when reference and round-trip pages render at different pane positions and different
   widths (Letter vs A4) in the same 3-column layout. Write the crops/diffs to the run's own work
   directory using the exact names `src/server/routes/files.ts`'s `RUN_FILE_NAMES` enum expects
   (`page-reference.png`, `page-diff.png`, etc. — exactly what `diff/pixel-diff.ts`'s `diffRegion()`
   already writes when given correct per-image geometry) so the page's diff pane and the files route
   can serve them.

Steps 4–6 are deliberately **not** wired into an HTTP route (see finding 2's scope note): the driving
agent computes them, using this package's own `render/regions.ts` (`cropRegion`) and
`diff/pixel-diff.ts` (`createPixelDiffer`, `diffRegions`) as a library, not through the server.

## Isolation from the root workspace

`tools/verify/pnpm-workspace.yaml` (`packages: []`) makes this an **isolated pnpm workspace root** —
`pnpm --dir tools/verify install` resolves its own `pnpm-lock.yaml`/`node_modules`, entirely
independent of the repo root's. Two invariants are pinned by tests, not just this paragraph:

- `src/workspace-isolation.test.ts` — re-running install against `tools/verify` never mutates the
  root's lockfile/`node_modules`, and `pnpm list -r` at each root never discovers the other as a
  workspace member (bidirectional — confirmed via a real, frozen-lockfile install plus a read-only
  `pnpm list -r`, not just static config inspection).
- `src/import-boundary.test.ts` — no file under `tools/verify` imports from the repo root's `src/**`,
  at compile time or runtime (static imports, dynamic `import()`, and `require()` are all scanned).
  Every shared response shape (`ParseJob`, `TemplateImportData`, `PropertyDecision`, ...) is an
  independently hand-mirrored Zod schema in `src/api-client/schemas.ts` — kept in sync with
  `openapi.yaml` by hand, not by importing `src/ast`'s own types.

## openapi.yaml no-op

This build adds zero endpoints to the SpecR REST API — every route in [HTTP API](#http-api) above
is this package's own separate Express server (`VERIFY_PORT`, default 4300), never mounted on the
main API. `git diff origin/main -- src/ openapi.yaml` is empty for this entire branch; the contract
gate (`src/api/contract.integration.test.ts`) has nothing new to check.

## Design decisions

Issue #150 explicitly scopes this as a `tools/`-only build with no ADR. This section is that
decision record — spike findings (WT-150, pre-build) and build findings (discovered while
implementing/verifying tasks 1–8) both numbered together in the order they were confirmed.

#### 1. `pnpm-workspace.yaml` must exist before the first install
Without `tools/verify/pnpm-workspace.yaml` (`packages: []`), `pnpm --dir tools/verify install`
silently resolves against the **repo root** importer instead: zero `node_modules` created under
`tools/verify`, "Already up to date" printed, no error. pnpm resolves the *nearest*
`pnpm-workspace.yaml` walking up from `cwd` and stops there — adding this file first made
`tools/verify` its own workspace root. The single most impactful spike finding; every other file in
this package depends on install actually working.

#### 2. Capture source: external Playwright screenshot only
An in-page `canvas`/`foreignObject` rasterization of the rendered panes (`window.__captureScreenshot`)
was prototyped and confirmed non-viable: it renders blank/gray in Chromium, because docx-preview's
injected stylesheet does not survive a cloned-subtree `foreignObject` rasterization. It was not
shipped, not even as a documented stub. The only capture path is external: a driving agent
(Playwright) screenshots the rendered page and `POST`s it to `/api/runs/:runId/screenshot` as base64
PNG — see [Driving a run](#driving-a-run-the-agent-workflow).

#### 3. Region geometry is viewport-relative, not document-relative
`window.__measure()`/`window.__regionGeom()` use `getBoundingClientRect()`, so `x`/`y` are relative to
the *viewport*, not the document. At an unpinned or too-narrow viewport, `x` can go negative (this
page's centered layout) or a region can extend past what the screenshot actually captured.
`render/regions.ts`'s `cropRegion()` bounds-checks every crop and throws `VerifyRenderError` rather
than ever silently clipping or writing a garbage crop — confirmed **load-bearing**, not defensive
paranoia (see finding 7, which is exactly this backstop catching a real, previously-undiscovered
misconfiguration).

#### 4. Two real API-client defects, fixed before they could ship
- Every multipart DOCX upload must set an explicit `Content-Type` on its `Blob` part
  (`api-client/client.ts`'s `DOCX_MIME` constant) — a type-less `Blob` omits `Content-Type` on the
  multipart part, and `src/api/parse.ts`'s `uploadMimeError()` genuinely 400s a request that arrives
  that way. Not cosmetic.
- `PropertyDecision.rejected` (from `POST /templates/import`'s derivation report) is an array of
  `{ value, count }` losing candidates, **not** a boolean, in the real API response — confirmed
  against both `openapi.yaml` and `src/parser/docx/derive-template.ts`, and again during this task's
  manual smoke test (a real run against the sample fixture produced
  `"rejected": [{ "value": 140, "count": 3 }]` entries, rendered correctly in the harness's sidebar
  as "rejected: 140 x3").

#### 5. `pixelmatch`'s ESM-only default export
`import pixelmatch from 'pixelmatch'` (v6+, ESM default-only) — never `require()`/CJS-interop-wrap
it; a future "fix" toward CJS interop would silently break under this package's NodeNext module
resolution. Pinned with an inline comment in `diff/pixel-diff.ts`, not just here.

#### 6. Pad-not-fail pixel diffing, validated against a real dimension mismatch
`createPixelDiffer().diff()` never throws on a canvas-dimension mismatch between the two images —
both are padded onto a shared `max(width) x max(height)` canvas first (zero-filled margin, via
`pngjs`'s `Buffer.alloc`-backed `PNG` constructor), so `diffRatio` is always defined and in `[0, 1]`.
This was validated against a **real** mismatch, not just contrived test fixtures: the sample
fixture's LibreOffice-authored reference is Letter (`12240x15840` twips, confirmed via
`word/document.xml`'s `w:pgSz`), while the SpecR generator's round-tripped output is A4
(`11906x16838`) regardless of the reference's page size. That is a genuine, out-of-scope generator
bug — the generator should presumably match the reference's page size (or the template's), not
default to A4 unconditionally. **Flagged as a follow-up issue, not worked around inside
`tools/verify`.**

#### 7. Viewport width must fit *both* panes, not just be "pinned" (task 8)
The WT-150 spike's original `VERIFY_VIEWPORT_WIDTH` default (900px) was carried through the design as
"pin the viewport before screenshotting," but the spike's own throwaway page (`.spike-150/spike-web`)
was a single full-width container — it never validated that number against the **shipped** harness
page's actual layout (`public/index.html`): reference / round-trip / diff as three equal-width grid
columns beside a fixed 320px sidebar. Confirmed via Playwright during this task's manual smoke test:
at 900px, **both** panes' `pageGeom.x` came back negative (`-312`, `-107`) — the viewport was
"pinned" exactly as documented, and `x` still went negative, because each pane's column
(`(900 - 320) / 3 ≈ 193px`) is far narrower than a Letter-width page (816 CSS px) that docx-preview
centers within it.

Re-derived the real constraint: `pageGeom.x >= 0` requires
`(viewportWidth - 320) / 3 >= 816`, i.e. `viewportWidth >= 2768`. The default is now **3200**
(config.ts, harness.js's mirrored constant, `.env.example`) — confirmed via Playwright to leave
~70px of margin on the tightest (first/reference) column. `config.test.ts` pins the arithmetic
directly so a future change to the default, the sidebar width, or the page-width assumption that
reopens this gap fails a test, not just a real capture. This is exactly what finding 3's bounds-check
backstop exists for — it would have caught this as a `VerifyRenderError` the first time a driving
agent tried to crop at the old default, rather than producing a silently wrong crop.

#### 8. `diffRegions()`'s shared-geometry assumption doesn't fit a side-by-side layout
`diff/pixel-diff.ts`'s `diffRegions()` crops **both** the reference and round-trip screenshots using
the *same* `Geom` rect (`RegionDiffInput.pageGeom`, one value applied to both `cropRegion()` calls).
That is correct when both screenshots already share one coordinate frame (e.g. each pane captured in
isolation, at the same relative position). It is **not** directly usable against a single screenshot
of this harness's 3-pane grid, where the reference and round-trip pages render at different `x`
offsets (different pane columns) and different widths (Letter 816px vs A4 794px) simultaneously.

Confirmed during the manual smoke test by driving the real harness: cropping each pane's screenshot
with its *own* geometry (via `cropRegion()` called twice, once per image, each with that image's own
rect) and then diffing the two crops directly with `createPixelDiffer().diff()` reproduced finding 6's
real dimension mismatch end to end — `paddedReference: true, paddedRoundtrip: true`,
`diffRatio ≈ 0.11` — with a visually sane diff image (overlapping text plus a solid padding margin on
the wider/taller side). **Guidance for any real driving-agent implementation**: capture each pane
separately (or compute pane-relative geometry by subtracting that pane's content-element origin from
the viewport-relative measurement) and crop each side with its own rect, rather than assuming
`diffRegions()`'s single shared rect fits a side-by-side layout. `diffRegions()` itself is unchanged —
it is correct for its stated contract; this is operational guidance for callers, not a code defect.

## Manual smoke test (task 8)

Run against a real, disposable Postgres + SpecR API (never mocked), driven end to end with
Playwright:

1. `docker compose`-provisioned Postgres, migrated and seeded (`spec_sections`: 666 rows).
2. Real SpecR API booted (`pnpm dev`, `NODE_ENV=test`, isolated `DATABASE_URL`).
3. `pnpm --dir tools/verify dev`, then drove the page through the real upload form
   (`tests/fixtures/libreoffice/csi-spec-sample.docx`) — confirmed the full pipeline (upload → parse
   → import → generate) completes against the real API, with a real `DerivationReport` whose
   `rejected` fields matched finding 4's corrected shape.
4. Resized to the corrected 3200px viewport, confirmed both panes' `pageGeom.x` non-negative
   (finding 7), captured per-pane screenshots, `POST`ed them to `/api/runs/:runId/screenshot`
   (200 for both panes), and confirmed `GET .../files/:filename` serves the uploaded/generated docx
   and the screenshots.
5. Cropped and diffed the two panes' page regions with the real production code (finding 8),
   confirming the pad-not-fail path runs against the real Letter-vs-A4 mismatch (finding 6) that this
   exact fixture produces, and inspected the resulting diff image visually.
6. `pnpm --dir tools/verify lint` and `pnpm --dir tools/verify test` green (168 tests, 14 files);
   root `pnpm lint`/`pnpm test` green and unaffected (`git diff origin/main` touches only
   `tools/verify/**` and `.gitignore`); `openapi.yaml` confirmed a no-op (above).
