# Live API Documentation — Design Spec

- **Status:** Approved (design) — ready for implementation planning
- **Date:** 2026-06-17
- **Author:** Claude Opus 4.8 (with thewrz)
- **Topic:** A navigable, interactive, always-true API reference for SpecR, published from `openapi.yaml`.

## Context & Problem

SpecR is a headless, API-first service. Its REST surface is described by `openapi.yaml`
(OpenAPI 3.1.0, ~3,100 lines), declared in `CLAUDE.md` as *"the authoritative API contract."*
There is no human-facing rendering of that contract, and — more importantly — nothing that
proves the contract is **true to the running code**. `openapi.yaml` is hand-maintained, so it
can silently drift: an endpoint changes, the spec doesn't, and any docs rendered from it become
confidently wrong. A published-but-wrong API reference is worse than none.

The goal is a developer-portal-style **interactive API reference** (navigable website with a
"Try-it" console, the experience Swagger UI popularised and Scalar/Redoc/Stoplight modernised),
generated from `openapi.yaml`, that is:

1. **Live** — republishes automatically as the project evolves and pushes to `main`.
2. **REAL / TRUE** — provably matches actual API behaviour, not just "rendered from a file."
3. **Interactive** — readers can execute real requests against a running SpecR.

## Goals

- Render `openapi.yaml` as a navigable, human-readable reference site.
- Make the published site auto-update on every push to `main`.
- **Guarantee the spec cannot drift from the code** via CI (the central requirement).
- Provide a working interactive "Try-it" console for local development today, designed so a
  hosted instance can be slotted in later without rework.

## Non-Goals (YAGNI)

- **No hosted/public demo instance** of the SpecR API in this work (deferred; see #43 for auth,
  which is a prerequisite for safely exposing a public instance).
- **No authentication** changes — `openapi.yaml` remains `security: []` for now.
- **No generate-spec-from-code refactor** — the spec stays hand-authored; we guarantee its
  truth by contract-testing rather than by derivation (see Decision 1).
- No Phase 5 React UI work; the docs site is standalone (with an embed path left open).

## Decisions (locked during brainstorming)

### Decision 1 — Truth model: contract-test the spec (not code-gen, not lint-only)

The spec stays hand-authored and readable, but CI validates **real API responses against
`openapi.yaml`** during the integration suite. The build goes red the moment a real response
stops matching the documented schema. This is stronger than route-coverage/lint-only and far
cheaper than deriving the spec from code, while fitting SpecR's existing "real Postgres, no
mocks" integration approach.

> This is a non-obvious architectural choice (rejecting the popular generate-from-code path) and
> therefore warrants an **ADR** during implementation, per `CLAUDE.md`.

### Decision 2 — Interactive target: local server now, hosted-ready

Publish a public, navigable reference; the Try-it console targets `http://localhost:3000` so a
developer running SpecR locally gets a working console. The `servers:` list is structured so a
hosted **https** URL drops in later (ties into #43). No infrastructure stood up now.

### Decision 3 — Renderer: Scalar (MIT)

Scalar provides a modern reference UI with a **built-in interactive client and server dropdown**,
and ships as a single static page. Chosen over Redoc (open-source build has no Try-it — execution
is a Redocly paid feature, which conflicts with the interactive requirement), Swagger UI (works,
but a more dated UI), and Stoplight Elements (kept in mind for a future Phase-5 embed).

## The Truth Through-Line

Three mechanisms chain to convert "rendered docs" into "docs that cannot lie." Remove any one and
the guarantee breaks:

```
code change ──▶ integration + CONTRACT tests must stay green
                        │   (real responses validated against openapi.yaml by ajv)
                        ▼
              openapi.yaml is provably true to the running code
                        │
   push to main ──▶ docs workflow republishes that SAME openapi.yaml
                        ▼
              published site == the contract == the code that shipped
```

- `redocly lint openapi.yaml` (already in CI's build job) proves the spec is **valid**.
- The new **contract test** proves the spec is **honest**.
- The **Pages workflow** proves the published site is **current**.

## Architecture — three surfaces, one spec, zero duplication

| Surface | What it is | Goal served |
|---|---|---|
| **`GET /docs`** (in Express) | Scalar reference served by SpecR itself, **same-origin** with the API | Working Try-it **locally today** — no CORS, no mixed-content |
| **GitHub Pages site** | Same Scalar page + `openapi.yaml`, auto-deployed on push to `main` | The always-current public **reference**; interactive once a hosted server exists |
| **Contract test** (`pnpm test:integration`) | ajv validates real responses against `openapi.yaml` | The **truth guarantee** — CI red on drift |

All three read the **one** `openapi.yaml`. Nothing is hand-copied between them.

### The mixed-content constraint (why `/docs` exists)

A public Pages site is served over **https**; browsers **block** an https page from calling
`http://localhost:3000` (mixed-content — a browser rule, not a configurable option). So Try-it
against localhost *from the public site* cannot work. The `/docs` route resolves this: opening
**`http://localhost:3000/docs`** serves the docs page same-origin with the API, so Try-it executes
for real, immediately, with no CORS. The public Pages site remains a first-class navigable
reference and its Try-it lights up the day the server dropdown points at a hosted **https**
instance (#43). This is exactly the "local now, hosted-ready" decision, made concrete.

## Components

1. **`src/api/docs.ts`** — two read-only handlers:
   - `GET /docs` → returns the Scalar HTML page (references `/openapi.yaml`).
   - `GET /openapi.yaml` → serves the spec file.
   Mounted in `src/api/router.ts`. No DB, no auth, no rate-limit. Keep within the 400-line file
   cap and 50-line function cap.
2. **Scalar asset** — `@scalar/api-reference` **vendored as a pinned npm dependency** and bundled
   at build time, *not* loaded from a bare CDN `<script>`, so the docs page does not execute
   un-pinned third-party code in readers' browsers (supply-chain hygiene per `security.md`). If a
   CDN is ever used, it must be version-pinned with a Subresource Integrity (SRI) hash.
3. **`tests/contract/validate-response.ts`** — loads and dereferences `openapi.yaml` once
   (reusing **`@redocly/openapi-core`**, already on disk via `@redocly/cli`, to avoid a new parser
   dependency), indexes operations by `(method, pathTemplate)`, and compiles each response schema
   with **ajv 2020** (`ajv/dist/2020`) + `ajv-formats`. A 3.1 schema *is* JSON Schema 2020-12, so
   ajv validates it directly. Exports `assertResponse(method, pathTemplate, status, body)`.
4. **`src/api/contract.integration.test.ts`** — boots the app with the existing inline pattern
   (`express()` + `router` + `errorHandler`, `listen(0)`, native `fetch`), exercises the core
   endpoints, and asserts each response satisfies the spec via `assertResponse`. Includes a
   **coverage assertion**: enumerate every operation in `openapi.yaml` and fail if one is never
   contract-checked, so a new undocumented/untested endpoint cannot slip through.
5. **`.github/workflows/docs.yml`** — on push to `main` + `workflow_dispatch`:
   `redocly lint` (fail fast) → assemble `docs-site/` (Scalar HTML + `openapi.yaml`) →
   `upload-pages-artifact` → `deploy-pages`. All actions **SHA-pinned**; a `concurrency` guard;
   least-privilege `permissions: { pages: write, id-token: write }`.
6. **`openapi.yaml` `servers:`** — keep `http://localhost:3000`; add a commented hosted-instance
   placeholder so the Scalar server dropdown is ready for #43.

## CI / Data Flow

```
PR / push ──▶ ci.yml: lint · tsc · prettier · unit · integration (now incl. contract test) · build (redocly lint)
                        │  contract test fails CI if any real response ≠ openapi.yaml
push to main ──▶ docs.yml: redocly lint ▶ assemble docs-site/ ▶ upload-pages-artifact ▶ deploy-pages
                        ▼
            https://<owner>.github.io/SpecR  (always == openapi.yaml on main)
local dev ──▶ http://localhost:3000/docs    (same-origin Scalar; Try-it executes for real)
```

## Testing Strategy (TDD)

- **TDD the contract helper:** write a failing test feeding a deliberately-wrong body and assert
  `assertResponse` rejects it (RED); implement the ajv wiring (GREEN); refactor. Pin with a
  regression test named for the symptom, per the SpecR convention.
- **The contract test is itself the regression guard** against spec drift for the covered
  endpoints; the coverage assertion guards against new endpoints escaping documentation.
- **Expect the first run to surface existing drift** between `openapi.yaml` and reality. That is
  the point of the exercise; fixes to genuine drift are tracked as small follow-ups if large.
- `redocly lint` remains the structural validity gate (unchanged, already in CI).
- No mocking of Postgres — contract tests run in the existing integration project against the real
  database, consistent with the rest of the suite.

## Contract Mechanism — chosen vs reserve

- **Chosen: bespoke ajv helper (Component 3).** Fits SpecR's native-`fetch` harness (the popular
  `jest-openapi` / `chai-openapi-response-validator` matchers expect axios/supertest-style response
  objects and read the request path off them — they do not fit native `fetch` without bolting on
  supertest). It is exactly right for OpenAPI 3.1 and adds the fewest dependencies.
- **Reserve: `express-openapi-validator`** (`validateResponses: true`, OpenAPI 3.1 supported since
  v5.4.0) mounted in a shared `createApp()` factory would validate *every* response automatically —
  broader coverage — but costs a new runtime dependency plus refactoring all ~15 integration tests
  onto a shared factory. Not pursued now; revisit if per-endpoint coverage proves too laborious.
  (Extracting a shared `createApp()` factory is independently worthwhile and noted as optional
  future tidy — the current tests each rebuild the app inline.)

## Security & Dependencies

- New dependencies are all permissive (MIT/Apache-2.0) per `security.md`: `ajv` + `ajv-formats`
  (MIT), `@scalar/api-reference` (MIT). Reuse `@redocly/openapi-core` (already present via
  `@redocly/cli`). Exact versions vetted for CVEs (`pnpm audit`) and SHA-pinned via the lockfile
  during planning.
- New GitHub Actions (`upload-pages-artifact`, `deploy-pages`, `configure-pages`) pinned to full
  commit SHAs, matching the existing CI convention.
- The docs page executes only bundled, pinned JS — no runtime third-party script unless pinned + SRI.
- `/docs` and `/openapi.yaml` are read-only and unauthenticated, consistent with the current
  `security: []` posture; they expose only the already-public contract.

## Delivery Plan — three small PRs (issue-first; `main` releasable throughout)

File one tracking issue first (no docs-portal issue exists in the tracker yet) with these as a
checklist:

1. **`feat(api): contract-test openapi.yaml against real responses`** — the truth guarantee
   (Components 3 + 4). Test-only; no runtime behaviour change. Includes the ADR for Decision 1.
2. **`feat(api): serve Scalar API reference at /docs + /openapi.yaml`** — local interactive docs
   (Components 1 + 2 + 6).
3. **`ci: publish API reference to GitHub Pages on push to main`** — the live public site
   (Component 5); enable Pages for the repo.

Each PR is ≤ ~150 LOC of real change and independently demonstrable.

## Open Questions / Future Work

- **Hosted instance + public Try-it:** requires #43 (auth) and a deploy target; revisit once auth
  lands. The server dropdown is being built ready for it.
- **Embedding docs in the Phase-5 React UI:** Stoplight Elements or Scalar's React component could
  embed the same `openapi.yaml`; out of scope now, not precluded.
- **express-openapi-validator** as a broader automatic guarantee (see Reserve, above).

## References

- express-openapi-validator (3.1 + `validateResponses`): https://github.com/cdimascio/express-openapi-validator
- OpenAPIValidators (jest/chai matchers): https://github.com/openapi-library/OpenAPIValidators
- Scalar: https://github.com/scalar/scalar · HTML/JS integration: https://scalar.com/products/api-references/integrations/html-js
- seriousme/openapi-schema-validator (3.1/3.2): https://github.com/seriousme/openapi-schema-validator
- Speakeasy — contract testing with OpenAPI: https://www.speakeasy.com/blog/contract-testing-with-openapi
