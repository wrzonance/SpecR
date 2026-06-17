# Live API Documentation — Design Spec

- **Status:** Approved (design) — ready for implementation planning
- **Date:** 2026-06-17
- **Revised:** 2026-06-17 — incorporates nine adversarial-review findings: CI-gated publish,
  bidirectional route↔spec coverage, scoped truth claims, declared dependencies, Scalar asset
  pipeline, corrected mixed-content rationale, Pages permissions, helper location, PR re-sequencing.
- **Author:** Claude Opus 4.8 (with thewrz)
- **Topic:** A navigable, interactive, continuously-verified API reference for SpecR, published
  from `openapi.yaml`.

## Context & Problem

SpecR is a headless, API-first service. Its REST surface is described by `openapi.yaml`
(OpenAPI 3.1.0, ~3,100 lines), declared in `CLAUDE.md` as *"the authoritative API contract."*
There is no human-facing rendering of that contract, and nothing that checks the contract stays
**true to the running code**. `openapi.yaml` is hand-maintained, so it can drift: an endpoint
changes, the spec doesn't, and any docs rendered from it become confidently wrong. A
published-but-wrong API reference is worse than none.

The goal is a developer-portal-style **interactive API reference** (navigable website with a
"Try-it" console, the experience Swagger UI popularised and Scalar/Redoc/Stoplight modernised),
generated from `openapi.yaml`, that is:

1. **Live** — republishes as the project evolves, but only after verification passes.
2. **Verified / honest** — CI proves the documented contract matches real API behaviour for the
   covered cases, and that no endpoint is undocumented. (See "Scope of the guarantee" — this is a
   continuously-enforced check, not a claim of mathematical impossibility.)
3. **Interactive** — readers can execute real requests against a running SpecR.

## Goals

- Render `openapi.yaml` as a navigable, human-readable reference site.
- Make the published site update on every verified push to `main`.
- **Continuously enforce that the spec matches the code** in CI — both directions (no documented
  operation untested for its response shape; no Express route missing from the spec).
- Provide a working interactive "Try-it" console for local development today, designed so a hosted
  instance can be slotted in later without rework.

## Non-Goals (YAGNI)

- **No hosted/public demo instance** of the SpecR API in this work (deferred; #43 adds auth, a
  prerequisite for safely exposing a public instance).
- **No authentication** changes — `openapi.yaml` remains `security: []` for now.
- **No generate-spec-from-code refactor** — the spec stays hand-authored; we enforce its truth by
  contract-testing rather than by derivation (see Decision 1).
- No Phase 5 React UI work; the docs site is standalone (with an embed path left open).

## Decisions (locked during brainstorming)

### Decision 1 — Truth model: contract-test the spec (not code-gen, not lint-only)

The spec stays hand-authored and readable, but CI validates **real API responses against
`openapi.yaml`** during the integration suite, and separately asserts **route↔spec coverage in both
directions**. The build goes red when a covered response stops matching the documented schema, or
when an Express route exists that the spec doesn't document (or vice-versa). This is stronger than
route-coverage-or-lint alone and far cheaper than deriving the spec from code, while fitting
SpecR's existing "real Postgres, no mocks" integration approach.

> This is a non-obvious architectural choice (rejecting the popular generate-from-code path) and
> therefore warrants an **ADR** during implementation, per `CLAUDE.md`. The ADR also records the
> *scope* of the guarantee (below) so a future reader doesn't over-trust it.

### Decision 2 — Interactive target: local server now, hosted-ready

Publish a public, navigable reference; the Try-it console targets `http://localhost:3000` so a
developer running SpecR locally gets a working console. The `servers:` list is structured so a
hosted **https** URL drops in later (ties into #43). No infrastructure stood up now.

### Decision 3 — Renderer: Scalar (MIT)

Scalar provides a modern reference UI with a **built-in interactive client and server dropdown**,
and ships a **prebuilt standalone browser bundle** inside its npm package (so it can be vendored
and served as a static file — no CDN, no app bundler). Chosen over Redoc (open-source build has no
Try-it — execution is a Redocly paid feature, which conflicts with the interactive requirement),
Swagger UI (works, but a more dated UI), and Stoplight Elements (kept in mind for a future Phase-5
embed).

## Scope of the guarantee (what "verified" does and does not mean)

The enforcement is **continuous verification of covered cases**, not proof that drift is
impossible. Stated precisely, CI guarantees:

- Every documented operation that a contract test exercises returns a response that **validates
  against its documented JSON response schema** for the tested status code.
- Every **Express route is documented** in `openapi.yaml`, and every documented operation has at
  least one contract assertion **or** is on an explicit, shrinking allowlist (see Delivery).

It does **not**, by itself, validate: request bodies, invalid-input branches, every status code,
response headers/content-negotiation, multipart uploads, or **binary downloads**. The spec already
contains `multipart/form-data` request bodies (3) and binary DOCX responses
(`application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `format: binary`, on
`/specs/{id}/generate` and `/projects/{id}/generate`). The JSON-body validator **skips non-JSON
media types** and records them as explicit coverage gaps rather than pretending to cover them.
Expanding to request-negative tests, headers, and binary content-type checks is tracked as
follow-up, not claimed here.

## The verification through-line

Four mechanisms chain to keep the published docs honest. Remove any one and the chain weakens:

```
code change ──▶ CI (one workflow): redocly lint
                                  · response contract test  (covered responses match openapi.yaml)
                                  · route↔spec coverage      (no undocumented route; no untested op)
                        │ all must pass
                        ▼
              openapi.yaml on main is verified-true for covered cases
                        │
   CI succeeds on main ──▶ docs workflow runs via `workflow_run` and republishes the SAME file
                        ▼
              published site == the verified contract == the code that shipped
```

- `redocly lint openapi.yaml` (already in CI's build job) proves the spec is **structurally valid**.
- The **response contract test** proves documented responses are **honest** for covered cases.
- The **route↔spec coverage assertion** proves the documentation is **complete** (no silent routes).
- The **`workflow_run` gate** proves the published site only ever reflects a **CI-verified** commit
  — not reliant on unstated branch-protection settings.

## Architecture — three surfaces, one spec, zero duplication

| Surface | What it is | Goal served |
|---|---|---|
| **`GET /docs`** (in Express) | Scalar reference served by SpecR itself, **same-origin** with the API | Working Try-it **locally today** — no CORS setup |
| **GitHub Pages site** | Same Scalar page + `openapi.yaml`, deployed **after CI succeeds on `main`** | The always-current public **reference**; interactive once a hosted server exists |
| **Contract + coverage test** (`pnpm test:integration`) | ajv validates covered responses against `openapi.yaml`; route↔spec manifest comparison | The **verification gate** — CI red on drift, in both directions |

All three read the **one** `openapi.yaml`. Nothing is hand-copied between them.

### Why the `/docs` route (same-origin Try-it)

A public Pages site is served over **https**; making its Try-it console call a reader's
`http://localhost:3000` is impractical and undesirable — not because of a blanket mixed-content
ban. Modern browsers treat loopback origins (`http://localhost`, `http://127.0.0.1`) as
*potentially trustworthy*, and Firefox 84+ / current Chromium **do not** block such requests as
mixed content. The real obstacles are **CORS** (the API would have to allow the `github.io`
origin), **Private/Local Network Access preflight**, **uneven Safari support**, and the simple fact
that we don't *want* a public site reaching into a developer's localhost.

The `/docs` route sidesteps all of that: opening **`http://localhost:3000/docs`** serves the docs
page **same-origin** with the API, so Try-it executes for real, immediately, with no CORS
configuration. The public Pages site remains a first-class navigable reference, and its Try-it
lights up the day the `servers` dropdown points at a hosted **https** instance (#43). This is the
"local now, hosted-ready" decision, made concrete.

## Components

1. **`src/api/docs.ts`** — read-only handlers, mounted in `src/api/router.ts`:
   - `GET /docs` → the Scalar HTML page (references the static bundle + `/openapi.yaml`).
   - `GET /openapi.yaml` → serves the spec file.
   - `GET /docs/scalar.js` (or a small static mount) → the vendored Scalar bundle (Component 2).
   No DB, no auth, no rate-limit. Within the 400-line file / 50-line function caps.
2. **Scalar asset (vendored, no CDN, no bundler)** — add `@scalar/api-reference` as a **pinned**
   dependency and copy its **prebuilt standalone browser bundle** (shipped inside the package's
   `dist/`) into a served location via a tiny `predocs`/`build` npm script — *not* a bare CDN
   `<script>` and *not* an app bundler (the repo build is `tsc`, which does not bundle browser JS).
   This keeps reader-side JS pinned and self-hosted (supply-chain hygiene per `security.md`). The
   same copied asset is reused by the Pages workflow. If a future change must use a CDN, it requires
   a version pin **and** a Subresource Integrity (SRI) hash.
3. **`src/test-utils/contract/validate-response.ts`** — the validator helper. Placed **under
   `src/`** (the repo's `tsconfig.json` sets `rootDir: "src"`, `include: ["src/**/*"]`, and Vitest
   discovers tests only under `src/**/*.integration.test.ts`; a helper outside `src` would violate
   `rootDir` under `tsc --noEmit`). Add `src/test-utils/**` to the Vitest coverage `exclude` list so
   test infrastructure doesn't distort the diagnostic. Behaviour:
   - Loads + dereferences `openapi.yaml` once using **`@apidevtools/json-schema-ref-parser`**
     (declared, pinned dev dependency — it parses YAML and resolves `$ref` natively).
   - Indexes operations by `(method, pathTemplate)`; for each, pulls the JSON response schema and
     compiles it with **ajv 2020** (`ajv/dist/2020`) + **`ajv-formats`** (declared, pinned). A 3.1
     schema *is* JSON Schema 2020-12, so ajv validates it directly; ajv is configured `strict:false`
     to tolerate OpenAPI annotation keywords (`discriminator`, `example`, `xml`, …).
   - **Does not** reuse the transitive `@redocly/openapi-core`: under pnpm it is not importable
     top-level (`ERR_MODULE_NOT_FOUND`) and the store carries two versions (1.34.x and 2.32.x) —
     an ambiguous, undeclared surface. We declare our own parser instead.
   - Exports `assertResponse(method, pathTemplate, status, body)` and `listOperations()` /
     `listJsonOperations()` for the coverage assertion.
4. **`src/api/contract.integration.test.ts`** — boots the app with the existing inline pattern
   (`express()` + `router` + `errorHandler`, `listen(0)`, native `fetch`) and enforces two things:
   - **(a) Response validation** for covered endpoints, starting with the read paths
     (`/health`, `/specs/{id}`, `/specs/{id}/lineage`, `/projects/{id}`, `/templates`,
     `/conventions`), each asserted with `assertResponse`.
   - **(b) Bidirectional route↔spec coverage** — derive the live Express route manifest from
     `router.stack` (each layer's `route.path` + `route.methods`), normalise param syntax
     (`:id` → `{id}`), and compare to the operation set in `openapi.yaml`. **Fail** if any Express
     route is absent from the spec, or any documented JSON operation has neither a contract
     assertion nor an allowlist entry. An explicit `EXCLUDE` set covers non-contract endpoints
     (`/docs`, `/docs/scalar.js`, `/openapi.yaml`, `/mcp`). This is the check that catches a new
     `router.post('/foo', …)` that was never added to `openapi.yaml`.
5. **`.github/workflows/docs.yml`** — **gated on CI**, not a parallel push trigger:
   ```yaml
   on:
     workflow_run:
       workflows: ["CI"]      # ci.yml's `name:`
       types: [completed]
       branches: [main]
     workflow_dispatch:
   permissions:               # restrictive block ⇒ list every scope needed
     contents: read           # required by actions/checkout (breaks on private repos if omitted)
     pages: write
     id-token: write
   concurrency:
     group: pages
     cancel-in-progress: false
   jobs:
     deploy:
       if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
       # checkout the *verified* commit: ref = github.event.workflow_run.head_sha
   ```
   Steps: checkout verified `head_sha` → `redocly lint` (defence in depth) → assemble `docs-site/`
   (Scalar HTML + vendored bundle + `openapi.yaml`) → `upload-pages-artifact` → `deploy-pages`. All
   actions **SHA-pinned**, matching the existing CI convention.
6. **`openapi.yaml` `servers:`** — keep `http://localhost:3000`; add a commented hosted-instance
   placeholder so the Scalar server dropdown is ready for #43.

## CI / Data Flow

```
PR / push ──▶ ci.yml ("CI"): lint · tsc · prettier · unit · integration  · build (redocly lint)
                                              │ integration now includes:
                                              │   - response contract test (covered ops)
                                              │   - route↔spec coverage (both directions)
                                              ▼ CI red on any drift
CI success on main ──▶ docs.yml (workflow_run, conclusion==success):
                         checkout head_sha ▶ redocly lint ▶ assemble docs-site/ ▶ upload-pages-artifact ▶ deploy-pages
                        ▼
            https://<owner>.github.io/SpecR   (== the CI-verified openapi.yaml on main)
local dev ──▶ http://localhost:3000/docs      (same-origin Scalar; Try-it executes for real)
```

## Testing Strategy (TDD)

- **TDD the validator helper:** write a failing test feeding a deliberately-wrong body and assert
  `assertResponse` rejects it (RED); implement the ref-parser + ajv wiring (GREEN); refactor. Pin
  with a regression test named for the symptom, per the SpecR convention.
- **The coverage assertion is itself the regression guard** against undocumented routes; the
  response assertions guard documented response shapes for covered operations.
- **Expect the first run to surface existing drift.** That is the point. Genuine drift is captured
  on the allowlist and burned down in follow-up PRs (see Delivery), so `main` stays green.
- `redocly lint` remains the structural validity gate (unchanged, already in CI).
- No mocking of Postgres — contract tests run in the existing integration project against the real
  database, consistent with the rest of the suite (`fileParallelism: false`).

## Contract Mechanism — chosen vs reserve

- **Chosen: bespoke ajv helper (Component 3).** Fits SpecR's native-`fetch` harness (the popular
  `jest-openapi` / `chai-openapi-response-validator` matchers expect axios/supertest-style response
  objects and read the request path off them — they do not fit native `fetch` without bolting on
  supertest). It is exactly right for OpenAPI 3.1 and uses three small, declared, MIT dependencies
  (`@apidevtools/json-schema-ref-parser`, `ajv`, `ajv-formats`).
- **Reserve: `express-openapi-validator`** (`validateResponses: true`, OpenAPI 3.1 supported since
  v5.4.0) mounted in a shared `createApp()` factory would validate *every* response automatically —
  broader coverage — but costs a new runtime dependency plus refactoring all ~15 integration tests
  onto a shared factory. Not pursued now; revisit if per-endpoint coverage proves too laborious.
  (Extracting a shared `createApp()` factory — the tests currently each rebuild the app inline — is
  independently worthwhile and noted as optional future tidy.)

## Security & Dependencies

- New dependencies are all permissive (MIT) per `security.md`, **declared directly and pinned**
  (never relied on transitively): `@apidevtools/json-schema-ref-parser`, `ajv`, `ajv-formats`
  (dev), and `@scalar/api-reference` (its prebuilt bundle is vendored and served locally). Versions
  vetted for CVEs (`pnpm audit`) and SHA-pinned via the lockfile during planning.
- New GitHub Actions (`configure-pages`, `upload-pages-artifact`, `deploy-pages`) pinned to full
  commit SHAs, matching existing CI.
- The docs page executes only the **vendored, pinned** Scalar bundle — no runtime third-party
  script (no CDN unless pinned + SRI).
- `/docs` and `/openapi.yaml` are read-only and unauthenticated, consistent with the current
  `security: []` posture; they expose only the already-public contract.
- `docs.yml` uses a least-privilege permission block that **explicitly includes `contents: read`**
  (a `permissions` block defaults every unlisted scope to `none`, which would break `checkout`).

## Delivery Plan — issue-first, `main` releasable throughout

File one tracking issue first (no docs-portal issue exists in the tracker yet) with these as a
checklist. The contract work is sequenced as **discovery → burn-down** so PR 1 doesn't have to
choose between "test-only" and "green CI" when pre-existing drift is found:

1. **`feat(api): contract + coverage gate for openapi.yaml`** — declare deps; add the validator
   helper (Component 3) and the contract/coverage test (Component 4). The **route↔spec coverage**
   check is strict from day one (it's about presence, cheap to satisfy). The **response
   validation** runs against all documented JSON operations but records currently-failing ones on
   an explicit **drift allowlist**, so CI is green while the real state is captured. Includes the
   ADR for Decision 1 (with the scope-of-guarantee section). *Realistically > 150 LOC* (deps +
   helper + allowlist + coverage) — focused, but not "test-only/150 LOC"; that earlier estimate was
   corrected.
2. **`fix(api): burn down openapi drift — <route group>`** (one or more small PRs) — fix genuine
   spec/code mismatches and remove allowlist entries until the allowlist is empty. Each PR is a
   small, demonstrable group.
3. **`feat(api): serve Scalar API reference at /docs + /openapi.yaml`** — local interactive docs
   (Components 1 + 2 + 6). Independent of drift burn-down; can land any time.
4. **`ci: publish API reference to GitHub Pages after CI succeeds on main`** — the live public site
   (Component 5), gated via `workflow_run`. Best landed once the allowlist is empty, so the public
   site is fully verified, not merely lint-valid.

## Open Questions / Future Work

- **Deeper contract coverage:** request-body validation, invalid-input/negative branches, response
  headers + content-negotiation, and binary/multipart media-type checks (today recorded as scoped
  gaps). `express-openapi-validator` is the reserve mechanism if breadth is wanted wholesale.
- **Hosted instance + public Try-it:** requires #43 (auth) and a deploy target; the server dropdown
  is being built ready for it.
- **Embedding docs in the Phase-5 React UI:** Stoplight Elements or Scalar's React component could
  embed the same `openapi.yaml`; out of scope now, not precluded.

## References

- express-openapi-validator (3.1 + `validateResponses`): https://github.com/cdimascio/express-openapi-validator
- OpenAPIValidators (jest/chai matchers): https://github.com/openapi-library/OpenAPIValidators
- Scalar: https://github.com/scalar/scalar · HTML/JS integration: https://scalar.com/products/api-references/integrations/html-js
- `@apidevtools/json-schema-ref-parser`: https://github.com/APIDevTools/json-schema-ref-parser
- Ajv (JSON Schema 2020-12): https://ajv.js.org/
- MDN — Mixed content (loopback exemption): https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content
- Mozilla bug 903966 — don't block mixed content from localhost: https://bugzilla.mozilla.org/show_bug.cgi?id=903966
- GitHub Actions — `deploy-pages` / `workflow_run` gating: https://github.com/actions/deploy-pages
- actions/checkout recommended permissions: https://github.com/actions/checkout
