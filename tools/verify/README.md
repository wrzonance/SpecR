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
| `POST` | `/api/runs` | Start a run: multipart `file` (the reference `.docx`) plus optional `section`/`title`/`sectionNumberFormat` fields. Returns `{ runId }` (202) immediately; the pipeline (upload → parse → import → generate) runs in the background. |
| `GET` | `/api/runs/:runId` | Poll a run's current `RunRecord` — `stage`, `status`, `artifacts`, and `error` if failed. |
| `POST` | `/api/runs/:runId/screenshot` | Ingest an externally-captured screenshot: JSON body `{ pane: 'reference'\|'roundtrip', imageBase64 }`. **This is the primary, and only, capture-ingestion path** — see [finding 2](#2-capture-source-external-playwright-screenshot-only). |
| `GET` | `/api/runs/:runId/files/:filename` | Serve one of a run's artifacts. `:filename` is a closed enum (`src/server/routes/files.ts`'s `RUN_FILE_NAMES`) — `reference.docx`, `generated.docx`, both screenshots, and the nine region crop/diff PNGs (`page-`/`header-`/`footer-` × `reference`/`roundtrip`/`diff`). |
| `POST` | `/api/header-footer-fixtures` | Start a header/footer fixture run (#305): JSON body `{ scenarioId }`, one of the 5 catalog ids in [Header/footer fixture scenarios](#header-footer-fixture-scenarios-305) below. Returns `{ runId }` (202) immediately; polls through the same `GET /api/runs/:runId` as the main upload form — both routes share one `RunStore`. No multipart upload: the reference `.docx` is built server-side from the catalog, not supplied by the caller. |

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

## Header/footer fixture scenarios (#305)

A second, self-contained entry point alongside the main upload-driven run: `POST
/api/header-footer-fixtures` builds its OWN reference `.docx` server-side from a small, closed
catalog (`src/fixtures/header-footer-scenarios.ts`'s `HEADER_FOOTER_SCENARIOS`), so exercising a
header/footer composition end to end needs no hand-prepared fixture file. Real CSI section/title
identities, never placeholders — the point is to drive the real API's own
library → project → header/footer-config → generate provisioning path (decision 5 below), not to
stub it.

| Scenario id | What it exercises |
|---|---|
| `default` | One default header/footer variant applied to every page. |
| `first` | A distinct first-page header (`w:titlePg`), different from the default variant. |
| `even` | A distinct even-page header (`w:evenAndOddHeaders`), different from the default (odd-page) variant. |
| `fields` | Header/footer fields resolved from the section's own identity (`sectionNumber`/`sectionTitle`), not literal text. |
| `restartPerSpec` | Page numbering restarts at 1 for this spec (`w:pgNumType w:start="1"`) instead of continuing the project's sequence — asserted by `src/fixtures/assert-page-numbering.ts`'s `assertPageNumberingRestart`. |

Drive all 5 through the real API (no mocks — same discipline as the main pipeline):

```bash
for s in default first even fields restartPerSpec; do
  curl -s -X POST http://localhost:4300/api/header-footer-fixtures \
    -H 'Content-Type: application/json' -d "{\"scenarioId\":\"$s\"}"
done
# poll GET /api/runs/:runId for each returned runId until stage=generate, status=complete
```

...or use the page's own **scenario picker** (`public/scenario-picker.js`, decision 9 below): pick a
scenario from the toolbar's dropdown and click "Start scenario run" — it reuses the exact same poll
loop and pane-loading logic as the main upload form (`harness.js` exposes `window.__pollRun` /
`window.__resetPaneState` for this purpose), so both entry points render into the same
reference/round-trip/diff panes.

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

### 1. `pnpm-workspace.yaml` must exist before the first install
Without `tools/verify/pnpm-workspace.yaml` (`packages: []`), `pnpm --dir tools/verify install`
silently resolves against the **repo root** importer instead: zero `node_modules` created under
`tools/verify`, "Already up to date" printed, no error. pnpm resolves the *nearest*
`pnpm-workspace.yaml` walking up from `cwd` and stops there — adding this file first made
`tools/verify` its own workspace root. The single most impactful spike finding; every other file in
this package depends on install actually working.

### 2. Capture source: external Playwright screenshot only
An in-page `canvas`/`foreignObject` rasterization of the rendered panes (`window.__captureScreenshot`)
was prototyped and confirmed non-viable: it renders blank/gray in Chromium, because docx-preview's
injected stylesheet does not survive a cloned-subtree `foreignObject` rasterization. It was not
shipped, not even as a documented stub. The only capture path is external: a driving agent
(Playwright) screenshots the rendered page and `POST`s it to `/api/runs/:runId/screenshot` as base64
PNG — see [Driving a run](#driving-a-run-the-agent-workflow).

### 3. Region geometry is viewport-relative, not document-relative
`window.__measure()`/`window.__regionGeom()` use `getBoundingClientRect()`, so `x`/`y` are relative to
the *viewport*, not the document. At an unpinned or too-narrow viewport, `x` can go negative (this
page's centered layout) or a region can extend past what the screenshot actually captured.
`render/regions.ts`'s `cropRegion()` bounds-checks every crop and throws `VerifyRenderError` rather
than ever silently clipping or writing a garbage crop — confirmed **load-bearing**, not defensive
paranoia (see finding 7, which is exactly this backstop catching a real, previously-undiscovered
misconfiguration).

### 4. Two real API-client defects, fixed before they could ship
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

### 5. `pixelmatch`'s ESM-only default export
`import pixelmatch from 'pixelmatch'` (v6+, ESM default-only) — never `require()`/CJS-interop-wrap
it; a future "fix" toward CJS interop would silently break under this package's NodeNext module
resolution. Pinned with an inline comment in `diff/pixel-diff.ts`, not just here.

### 6. Pad-not-fail pixel diffing, validated against a real dimension mismatch
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

### 7. Viewport width must fit *both* panes, not just be "pinned" (task 8)
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

### 8. `diffRegions()`'s shared-geometry assumption doesn't fit a side-by-side layout
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

### 9. A real HTTP route, not test/script-only — with a cuttable UI
`POST /api/header-footer-fixtures` is a real Express route (`server/routes/header-footer-fixtures.ts`),
not a test-only helper, matching issue #305's acceptance criterion framing (driving a scenario through
the harness's own UI, the same way the main upload form does). The scenario-picker UI
(`public/scenario-picker.js`) was scoped as **cuttable first** under LOC pressure — the route + fixture
pipeline stay independently useful via `curl`/Playwright alone even without it — but it shipped: it is
~50 lines and reuses `harness.js`'s existing poll loop verbatim (two new `window.__pollRun` /
`window.__resetPaneState` exports), so the marginal cost was small enough not to cut.

### 10. `HeaderFooterConfig.config` stays a loose Zod catchall
Same posture as `PropertyDecision`/`DerivationReport` elsewhere in `schemas.ts`: this harness only ever
round-trips a header/footer composition **it itself PUT** (via `putProjectHeaderFooter`) — it never
has to interpret an externally-authored config it didn't write. A loose `.catchall`-style shape is
sufficient and avoids hand-mirroring `openapi.yaml`'s full recursive `HeaderFooterComposition` schema
(fields, tables, rule lines, image data, ADR-021's open extensions) a second time in this package.

### 11. Two real build-time defects in this harness's OWN schemas — found live, fixed inline
Both surfaced only once every one of #305's 5 scenarios was actually driven through the real API (task
7/7's smoke test) — not caught by the earlier tasks' unit tests, which mocked the wire shapes rather
than asserting them against a live response. Confirmed both are bugs in **this package's own**
hand-mirrored types, not `src/` drift (`openapi.yaml` and the real handlers already agree with each
other on both shapes):

- `OnboardingJobResultSchema.report` was typed as `DerivationReportSchema` directly. The real
  `GET /libraries/import/jobs/{jobId}` 200 nests that `{nodeTypes, skippedNodeTypes, vanishSkipped}`
  shape under `report.styleDerivation` (nullable) inside a larger `OnboardingReport` object
  (`{styleDerivation, styleSourceNeeded, headerFooter, editability, hierarchy, parseWarnings}`,
  `openapi.yaml`'s own `required` list). Every one of the 5 scenarios failed at stage `'upload'` with a
  Zod error on `report.nodeTypes` (`expected array, received undefined`) before this fix.
- `HeaderFooterVariantInput`'s `header.center` / `footer.center` carried a bare field object
  (`{kind, text}`) directly. The real API models a region position as a **Cell** wrapping a `content`
  array (`src/ast/header-footer-schemas.ts`'s `HeaderFooterCellSchema`) — `{content: [{kind, text}]}`.
  Because that schema is `.catchall(JsonValue)` (ADR-021's open-extension posture), the bare field
  object still validated as a Cell with an absent `content` and two unknown extra keys — `PUT`/`GET`
  both "succeeded" and echoed it back unchanged, but the generator's `buildRegionChildren` reads
  `cell.content` and found nothing: **every one of the 5 scenarios generated with zero
  headers/footers in the output OOXML** (jszip-confirmed: no `headerReference`/`footerReference` at
  all) despite the PUT/GET round-trip reporting success. This is the sharper of the two — a
  request that validates and a response that echoes it back can still be silently wrong three layers
  downstream, when every layer in between is `.catchall`-open by design (ADR-021) and none of them
  assert what the *generator* actually consumes.

### 12. `docx-preview` 0.4.0 ignores a paragraph's own direct `pageBreakBefore`
The `'first'`/`'even'` scenario fixtures need a real page 2 to show their page-variant header on.
`buildScenarioReferenceDocx` originally set `docx`'s `pageBreakBefore: true` paragraph option — this
writes a valid `<w:pPr><w:pageBreakBefore/></w:pPr>` (confirmed via jszip), but the vendored
`docx-preview` build's own pagination (`splitBySection`, `node_modules/docx-preview/dist/docx-preview.js`)
only reads `pageBreakBefore` from a **named style**'s resolved properties
(`findStyle(elem.styleName)?.paragraphProps?.pageBreakBefore`) — never a paragraph's own direct `pPr`
override, which `docx`'s constructor option produces. Confirmed live: the reference pane rendered as a
single page despite a structurally valid `w:pageBreakBefore` being present in the XML. Fixed by
switching to a run-level break (`docx`'s `PageBreak`, emitting `<w:br w:type="page"/>`) — the one
page-break mechanism `docx-preview`'s `isPageBreakElement` DOES honor regardless of style
(`elem.break == "page"`), confirmed by re-driving the `'even'` scenario through Playwright: the
reference pane now reaches page 2 with a non-null `headerGeom` (see the smoke-test section below for
why the round-tripped pane still doesn't).

### 13. Scenario `id`s are the SOLE source of the route's request schema
`server/routes/header-footer-fixtures.ts`'s `StartHeaderFooterFixtureBodySchema` builds its `z.enum`
from `HEADER_FOOTER_SCENARIOS.map((s) => s.id)` at module load, rather than hand-listing the 5 ids a
second time — a scenario added to or removed from the catalog never needs a matching edit in the route
to stay in sync. Same "derive from the one source of truth" posture as decision 4's `RUN_FILE_NAMES`
enum in the sibling `files.ts` route.

## Known limitations

### PAGE-field pixel-invisibility
A header/footer field of kind `'pageNumber'` (`HeaderFooterFieldKindSchema`, `src/ast/`) makes the real
generator emit a genuine Word field (`docx`'s `PageNumber.CURRENT` sentinel →
`src/generator/header-footer-fields.ts`'s `resolvePageNumber`, a real `w:fldSimple`/`PAGE` field code) —
not static text. Word computes and displays that field's value only when the document is opened or
its fields are updated; the vendored `docx-preview` 0.4.0 build has **no render case at all** for
`DomType.SimpleField` in its `renderElement()` switch (confirmed by reading
`node_modules/docx-preview/dist/docx-preview.js` directly — every other `DomType` has a case, this one
falls through to nothing). A `pageNumber` field therefore renders as **visually empty** in every pane
this harness produces — present in the OOXML, present in `docx-preview`'s parsed DOM, invisible in the
screenshot. None of #305's 5 catalog scenarios use `pageNumber` (all use `literal`/`sectionNumber`/
`sectionTitle`, which resolve to real static text), so this doesn't block today's smoke test, but a
future scenario exercising `pageNumber` would pixel-diff as a false "match" (both sides blank) or a
false "mismatch" against a non-blank expectation — never a meaningful comparison. Not a `tools/verify`
bug and not `src/` drift: it's a genuine gap in the vendored preview library between "the OOXML is
correct" and "a static screenshot can show it."

### Round-tripped output never reaches page 2 for a manual page break
Filed as [issue #497](https://github.com/wrzonance/SpecR/issues/497) — not fixed here, per this
task's "file a separate issue for `src/` drift, don't fix inline" convention. `src/parser/`, `src/ast/`,
and `src/generator/` have no `pageBreak` concept anywhere: a reference DOCX's run-level page break
(decision 12's fix) round-trips through `parse → import → generate` as if it were never there —
confirmed via jszip (the generated `document.xml` has no `w:br w:type="page"` anywhere) and via
Playwright (`window.__measure('roundtrip').pageCount` stays `1` while the reference pane correctly
shows `2`). Practical consequence for this harness: the `'first'`/`'even'` scenarios' page-variant
header can be visually verified on the **reference** pane's page 2, but the **round-tripped** pane
never has a page 2 to compare it against — `diffPaneRegions`'s single-side-present fallback (decision 7
in the original #150 build) would crop the round-tripped screenshot at the reference's page-2 header
coordinates, which fall outside that screenshot's actual (1-page-tall) bounds; `render/regions.ts`'s
`cropRegion()` bounds-check throws `VerifyRenderError` rather than producing a garbage crop — the
correct, safe failure mode, but not a diff. **Don't trust `diffPaneRegions` for a `'first'`/`'even'`
scenario's page-2+ header/footer region until #497 is resolved** — page 1 (the `default` variant, on
both scenarios) diffs correctly today.

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

## Header/footer fixture smoke test (#305 task 7/7)

Run against the same kind of real, disposable Postgres + SpecR API as the #150 smoke test above —
never mocked — plus a real `jszip` inspection of every generated `.docx` and a Playwright drive of the
scenario-picker UI:

1. Real SpecR API booted against an isolated, migrated + seeded Postgres (`DATABASE_URL` passed
   inline); `pnpm --dir tools/verify dev` equivalent (`tsx src/index.ts` with `SPECR_API_BASE_URL`
   pointed at it).
2. All 5 catalog scenarios started via `POST /api/header-footer-fixtures` and polled to
   `stage: "generate", status: "complete"` — first pass surfaced decision 11's two schema bugs (every
   run failed at stage `'upload'`); fixed inline, re-run, all 5 completed.
3. Every scenario's `generated.docx` unzipped and its `word/document.xml` / `header*.xml` /
   `footer*.xml` inspected directly (not just "did it 200") — confirmed each scenario's exact expected
   text landed in the right header/footer part (`'PROJECT MASTER'`/`'07 92 00'` for `default`,
   `'CONTINUATION'`/`'COVER PAGE'` + `w:titlePg` for `first`, `'ODD PAGE'`/`'EVEN PAGE'` +
   `evenAndOddHeaders` for `even`, the literal section number/title for `fields`, and
   `w:pgNumType w:start="1"` for `restartPerSpec`) — this is what surfaced decision 11's second schema
   bug (all 5 generated with zero headers/footers before the `HeaderFooterCellInput` fix, despite every
   API call along the way reporting success).
4. `src/fixtures/assert-page-numbering.ts`'s `assertPageNumberingRestart` re-run directly against the
   real `restartPerSpec` output: passes at the expected `startAt`, throws (naming the actual value
   found) against a wrong one, and throws (`'not found'`) against the `default` scenario's continuous
   numbering — all three confirmed against real generated bytes, not synthetic fixtures.
5. `'even'` scenario driven through the actual browser page via Playwright: resized to the 3200px
   viewport, selected `even` in the scenario picker, clicked "Start scenario run," waited for
   `stage=generate status=complete`, then called `window.__measure()` on both panes. Reference pane:
   `pageCount: 2`, page 2's `headerGeom` non-null (`EVEN PAGE` visible). Round-trip pane: `pageCount: 1`
   — confirms [Known limitations](#known-limitations)'s page-break-drop finding empirically, not just
   by reading `src/`; `diffPaneRegions` is NOT trusted for this scenario's page-2 header per that
   section.
6. [Issue #497](https://github.com/wrzonance/SpecR/issues/497) filed for the confirmed `src/`
   round-trip gap (manual page breaks); decision 11's two schema bugs were `tools/verify`'s own and
   fixed inline, not filed.
7. `pnpm --dir tools/verify lint` and `pnpm --dir tools/verify test` green; `src/openapi-noop.test.ts`
   (new) and `src/file-line-budget.test.ts` both pin this PR's two boundary invariants
   (`git diff origin/main -- src/ openapi.yaml` empty; no `tools/verify/src` file over 400 lines);
   `src/import-boundary.test.ts` and `src/workspace-isolation.test.ts` re-run clean; root `pnpm lint`/
   `pnpm test` unaffected (`git diff origin/main -- src/ openapi.yaml` confirmed empty for the whole
   branch).
