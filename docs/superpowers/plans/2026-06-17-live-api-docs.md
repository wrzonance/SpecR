# Live API Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a navigable, interactive Scalar API reference for SpecR that is continuously verified against the running code and republished only after CI passes on `main`.

**Architecture:** A test-time **contract harness** validates real API responses against `openapi.yaml` (ajv 2020) and asserts bidirectional **route↔spec coverage** (Express `router.stack` vs OpenAPI paths). SpecR serves a **same-origin Scalar reference at `/docs`** (working Try-it locally). A **`workflow_run`-gated GitHub Pages workflow** republishes the same `openapi.yaml` after the `CI` workflow succeeds on `main`.

**Tech Stack:** TypeScript/Node 22, Express 5, Vitest, Zod v4, `@apidevtools/json-schema-ref-parser`, `ajv` (2020 dialect) + `ajv-formats`, `@scalar/api-reference`, GitHub Pages (`configure-pages`/`upload-pages-artifact`/`deploy-pages`).

## Global Constraints

_Every task implicitly includes these. Values copied from `CLAUDE.md` / the design spec._

- **Branch:** all work on `feat/live-api-docs` (already created off `origin/main`; holds the design spec + this plan). Never commit to `main`.
- **ESLint (error, not warning):** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console`, `@typescript-eslint/no-explicit-any`. Test files (`src/**/*.test.ts`, incl. `*.integration.test.ts`) relax only the line/console caps — **`no-explicit-any` and type-checked rules still apply in tests** (no `any`, no `as unknown as`).
- **TS strict** plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`. ESM project: relative imports use `.js`; type-only imports use `import type`. `tsconfig.json` is `rootDir: "src"`, `include: ["src/**/*"]` — **all new TS lives under `src/`**.
- **Modules import via a sibling's `index.ts` barrel**, never internals. `lib/` is imported per-file.
- **Dependencies:** MIT/Apache-2.0 only; declare directly + pin; `pnpm audit` clean before commit; never rely on a transitive package being importable.
- **GitHub Actions pinned to full commit SHA** with a `# vX.Y.Z` comment.
- **Commits:** Conventional Commits `type(scope): subject`; end every commit with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. PR-only — do not merge.
- **Verification scope:** the contract harness checks **JSON response bodies for covered/allowlisted operations only**. Request bodies, negative inputs, headers, and binary/multipart media types are explicit out-of-scope gaps (tracked, not claimed).

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `package.json` | modify | Add pinned deps + `vendor:scalar` script |
| `vitest.config.ts` | modify | Exclude `src/test-utils/**` from coverage |
| `src/test-utils/contract/validate-response.ts` | create | Load/dereference spec; `assertResponse`; route/spec/JSON manifests (production-strict file) |
| `src/test-utils/contract/validate-response.test.ts` | create | Unit test for the helper (no DB) |
| `src/api/contract.integration.test.ts` | create | Boots app; structural coverage + response-coverage gate + starter response assertions |
| `docs/adr/026-openapi-contract-testing.md` | create | ADR for Decision 1 (truth model + scope) |
| `src/api/docs-assets.ts` | create | Resolve + copy the vendored Scalar bundle into `public/scalar/` |
| `scripts/vendor-scalar.ts` | create | CLI wrapper invoking `vendorScalarAssets()` |
| `src/api/docs.ts` | create | `registerDocsRoutes(app)` → `GET /docs`, `/docs/scalar.js`, `/docs/scalar.css`, `/openapi.yaml` |
| `src/index.ts` | modify | Mount `registerDocsRoutes(app)` |
| `src/api/docs.integration.test.ts` | create | Boots app with docs routes; asserts 200 + content types |
| `.gitignore` | modify | Ignore `public/` |
| `docs/site/index.html` | create | Relative-path Scalar page for Pages |
| `.github/workflows/docs.yml` | create | `workflow_run`-gated Pages deploy |
| `openapi.yaml` | modify | Add commented hosted-server placeholder |

**PR grouping:** Tasks 1–4 → PR1 (contract gate + ADR). Task 5 → PR2…N (allowlist burn-down). Tasks 6–7 → PR3 (serve `/docs`). Task 8 → PR4 (publish). `main` stays releasable after every task.

---

### Task 1: Add and vet the contract-testing dependencies

**Files:**
- Modify: `package.json` (devDependencies)

**Interfaces:**
- Produces: dev deps `@apidevtools/json-schema-ref-parser`, `ajv`, `ajv-formats` importable from `src/`.

- [ ] **Step 1: Install pinned dev dependencies**

```bash
pnpm add -D @apidevtools/json-schema-ref-parser ajv ajv-formats
```

- [ ] **Step 2: Vet licenses + CVEs**

Run: `pnpm audit --prod && pnpm why ajv @apidevtools/json-schema-ref-parser`
Expected: no advisories; confirm all three are MIT in their `package.json`. If `pnpm audit` reports a fixable advisory, bump within the same major and re-run.

- [ ] **Step 3: Smoke-test the import shapes (ESM + verbatimModuleSyntax)**

Run:
```bash
node --input-type=module -e "import Ajv2020 from 'ajv/dist/2020'; import addFormats from 'ajv-formats'; import \$RefParser from '@apidevtools/json-schema-ref-parser'; const a=new Ajv2020({strict:false}); addFormats(a); const s=await \$RefParser.dereference('openapi.yaml'); console.log('OK', typeof a.compile, !!s.paths)"
```
Expected: `OK function true` (proves the default-import shapes and that `dereference` parses the YAML).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(api): add pinned ajv + json-schema-ref-parser for contract tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Contract validator helper

**Files:**
- Create: `src/test-utils/contract/validate-response.ts`
- Create (test): `src/test-utils/contract/validate-response.test.ts`
- Modify: `vitest.config.ts` (coverage `exclude`)

**Interfaces:**
- Produces:
  - `loadSpec(): Promise<OpenApiDoc>` — dereferenced, Zod-validated spec (memoized).
  - `assertResponse(method: string, pathTemplate: string, status: number, body: unknown): Promise<void>` — throws if a JSON body fails its documented schema; **no-ops for non-JSON responses**.
  - `expressRouteManifest(router: Router): string[]` — normalized `"method /path/{}"` entries.
  - `specOperationManifest(doc: OpenApiDoc): string[]` — same normalized form for documented ops.
  - `successJsonOps(doc: OpenApiDoc): string[]` — normalized ops whose 2xx response is `application/json`.

- [ ] **Step 1: Exclude test-utils from coverage**

In `vitest.config.ts`, add `'src/test-utils/**'` to `test.coverage.exclude` (alongside `src/index.ts` etc.).

- [ ] **Step 2: Write the failing unit test**

Create `src/test-utils/contract/validate-response.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  assertResponse,
  specOperationManifest,
  successJsonOps,
  loadSpec,
} from './validate-response.js'

describe('contract validate-response helper', () => {
  it('accepts a body that matches the documented schema', async () => {
    const body = { success: true, data: { db: 'connected', uptime: 5 } }
    await expect(assertResponse('get', '/health', 200, body)).resolves.toBeUndefined()
  })

  it('rejects a body that violates the documented schema', async () => {
    const body = { success: true } // missing required `data`
    await expect(assertResponse('get', '/health', 200, body)).rejects.toThrow(/does not match/)
  })

  it('no-ops for an operation without a JSON response schema', async () => {
    // 204 No Content has no application/json schema
    await expect(assertResponse('delete', '/specs/{id}/lock', 204, undefined)).resolves.toBeUndefined()
  })

  it('normalizes path params to {} so manifests are param-name agnostic', async () => {
    const doc = await loadSpec()
    expect(specOperationManifest(doc)).toContain('get /specs/{}')
    expect(successJsonOps(doc)).toContain('get /health')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- validate-response`
Expected: FAIL — `Cannot find module './validate-response.js'`.

- [ ] **Step 4: Implement the helper**

Create `src/test-utils/contract/validate-response.ts`:

```typescript
import { fileURLToPath } from 'node:url'
import type { Router } from 'express'
import $RefParser from '@apidevtools/json-schema-ref-parser'
import Ajv2020 from 'ajv/dist/2020'
import type { AnySchemaObject, ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { z } from 'zod'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const SPEC_PATH = fileURLToPath(new URL('../../../openapi.yaml', import.meta.url))

const SchemaObject = z.record(z.string(), z.unknown())
const ResponseObject = z.object({
  content: z.record(z.string(), z.object({ schema: SchemaObject.optional() })).optional(),
})
const OperationObject = z.object({
  responses: z.record(z.string(), ResponseObject).optional(),
})
const OpenApiDocSchema = z.object({
  servers: z.array(z.object({ url: z.string() })).optional(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
})
export type OpenApiDoc = z.infer<typeof OpenApiDocSchema>

const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
const validators = new WeakMap<object, ValidateFunction>()

function normalizePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, '{}').replace(/\{[^}]+\}/g, '{}')
}

let specPromise: Promise<OpenApiDoc> | null = null
export function loadSpec(): Promise<OpenApiDoc> {
  specPromise ??= $RefParser.dereference(SPEC_PATH).then((raw) => OpenApiDocSchema.parse(raw))
  return specPromise
}

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  let validate = validators.get(schema)
  if (!validate) {
    validate = ajv.compile(schema as AnySchemaObject)
    validators.set(schema, validate)
  }
  return validate
}

export async function assertResponse(
  method: string,
  pathTemplate: string,
  status: number,
  body: unknown,
): Promise<void> {
  const doc = await loadSpec()
  const rawOp = doc.paths[pathTemplate]?.[method.toLowerCase()]
  if (rawOp === undefined) throw new Error(`No OpenAPI operation: ${method} ${pathTemplate}`)
  const op = OperationObject.parse(rawOp)
  const schema = op.responses?.[String(status)]?.content?.['application/json']?.schema
  if (!schema) return // non-JSON (binary / 204 / multipart) — out of scope
  const validate = getValidator(schema)
  if (!validate(body)) {
    throw new Error(
      `Response body for ${method} ${pathTemplate} (${status}) does not match openapi.yaml: ` +
        ajv.errorsText(validate.errors),
    )
  }
}

export function expressRouteManifest(router: Router): string[] {
  const { stack } = router as Router & {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[]
  }
  const out: string[] = []
  for (const layer of stack) {
    if (!layer.route) continue
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.push(`${method} ${normalizePath(layer.route.path)}`)
    }
  }
  return out
}

function eachOperation(doc: OpenApiDoc): { method: string; path: string; raw: unknown }[] {
  const out: { method: string; path: string; raw: unknown }[] = []
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const raw = item[method]
      if (raw !== undefined) out.push({ method, path, raw })
    }
  }
  return out
}

export function specOperationManifest(doc: OpenApiDoc): string[] {
  return eachOperation(doc).map(({ method, path }) => `${method} ${normalizePath(path)}`)
}

export function successJsonOps(doc: OpenApiDoc): string[] {
  const out: string[] = []
  for (const { method, path, raw } of eachOperation(doc)) {
    const op = OperationObject.parse(raw)
    const has2xxJson = Object.entries(op.responses ?? {}).some(
      ([status, r]) => status.startsWith('2') && r.content?.['application/json'] !== undefined,
    )
    if (has2xxJson) out.push(`${method} ${normalizePath(path)}`)
  }
  return out
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- validate-response`
Expected: PASS (4 tests).

- [ ] **Step 6: Lint (helper is production-strict)**

Run: `pnpm lint`
Expected: clean. (No `any`, every function ≤ 50 lines, file ≤ 400.)

- [ ] **Step 7: Commit**

```bash
git add src/test-utils/contract/ vitest.config.ts
git commit -m "test(api): add openapi response-contract validator helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Contract + coverage integration gate

**Files:**
- Create: `src/api/contract.integration.test.ts`

**Interfaces:**
- Consumes: `assertResponse`, `expressRouteManifest`, `specOperationManifest`, `successJsonOps`, `loadSpec` (Task 2); `router` from `src/api/router.ts`.

**Context:** the router (44 routes) and `openapi.yaml` (44 operations) are already structurally in sync, so the parity assertions pass immediately. There are 41 success-JSON operations; 3 are response-asserted now (`get /health`, `get /conventions`, `get /templates` — all seeded, no per-test fixtures), the other 38 start on the allowlist.

- [ ] **Step 1: Write the contract test**

Create `src/api/contract.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { router } from './router.js'
import { errorHandler } from './middleware/error.js'
import {
  assertResponse,
  expressRouteManifest,
  specOperationManifest,
  successJsonOps,
  loadSpec,
} from '../test-utils/contract/validate-response.js'

// MCP is registered separately (not on `router`); exclude defensively.
const EXCLUDE = new Set(['post /mcp', 'get /mcp', 'delete /mcp'])

// Response bodies asserted in this file.
const RESPONSE_COVERED = new Set(['get /health', 'get /conventions', 'get /templates'])

// Documented JSON ops not yet response-verified (burned down in PR2…N).
const RESPONSE_ALLOWLIST = new Set([
  'delete /packages/{}', 'delete /projects/{}/specs/{}', 'delete /specs/{}/lock',
  'delete /specs/{}/style-source', 'get /libraries/{}/conventions',
  'get /libraries/{}/divisions/{}/general-spec', 'get /parse/jobs/{}', 'get /projects/{}',
  'get /projects/{}/divisions/{}/general-spec', 'get /projects/{}/packages',
  'get /projects/{}/references/broken', 'get /projects/{}/references/inbound',
  'get /projects/{}/specs/{}/references', 'get /revisions/{}', 'get /specs/{}',
  'get /specs/{}/lineage', 'get /specs/{}/lock', 'get /templates/{}', 'patch /specs/{}',
  'patch /specs/{}/paragraphs/{}', 'patch /templates/{}', 'post /libraries/{}/conventions/clone',
  'post /packages/{}/revisions', 'post /parse', 'post /projects', 'post /projects/{}/packages',
  'post /projects/{}/specs', 'post /specs/{}/diff', 'post /specs/{}/merge',
  'post /specs/{}/style-source', 'post /templates', 'post /templates/import',
  'post /templates/{}/rules', 'put /libraries/{}/conventions',
  'put /libraries/{}/divisions/{}/general-spec', 'put /packages/{}/specs',
  'put /projects/{}/divisions/{}/general-spec', 'put /specs/{}/lock',
])

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.use(router)
  app.use(errorHandler)
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 3000
  baseUrl = `http://localhost:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

describe('openapi structural coverage (route <-> spec, both directions)', () => {
  it('every Express route is documented and every documented op is implemented', async () => {
    const doc = await loadSpec()
    const exp = new Set(expressRouteManifest(router))
    const spec = new Set(specOperationManifest(doc))
    const undocumented = [...exp].filter((o) => !spec.has(o) && !EXCLUDE.has(o)).sort()
    const unimplemented = [...spec].filter((o) => !exp.has(o) && !EXCLUDE.has(o)).sort()
    expect(undocumented, 'Express routes missing from openapi.yaml').toEqual([])
    expect(unimplemented, 'openapi.yaml operations with no Express route').toEqual([])
  })

  it('every success-JSON operation is response-covered or explicitly allowlisted', async () => {
    const doc = await loadSpec()
    const uncovered = successJsonOps(doc).filter(
      (o) => !RESPONSE_COVERED.has(o) && !RESPONSE_ALLOWLIST.has(o) && !EXCLUDE.has(o),
    )
    expect(uncovered, 'JSON ops needing a response assertion or allowlist entry').toEqual([])
  })
})

describe('response contract (covered endpoints)', () => {
  it('GET /health matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    await assertResponse('get', '/health', 200, await res.json())
  })

  it('GET /conventions matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/conventions`)
    expect(res.status).toBe(200)
    await assertResponse('get', '/conventions', 200, await res.json())
  })

  it('GET /templates matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/templates`)
    expect(res.status).toBe(200)
    await assertResponse('get', '/templates', 200, await res.json())
  })
})
```

- [ ] **Step 2: Run the contract test**

Run: `pnpm test:integration -- contract`
Expected: PASS (5 tests). If the structural test reports many `unimplemented` entries, `expressRouteManifest` likely returned `[]` — log one `router.stack` layer to confirm the Express 5 shape, then fix the typed accessor in the helper. If a response assertion fails, that endpoint has **real drift** — move it from `RESPONSE_COVERED` to `RESPONSE_ALLOWLIST` and open a burn-down item (Task 5) rather than weakening the schema.

- [ ] **Step 3: Lint + full integration suite**

Run: `pnpm lint && pnpm test:integration`
Expected: clean; all integration tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/api/contract.integration.test.ts
git commit -m "test(api): contract + bidirectional route<->spec coverage gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: ADR for the contract-test truth model

**Files:**
- Create: `docs/adr/026-openapi-contract-testing.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/026-openapi-contract-testing.md`:

```markdown
# 026 — OpenAPI as hand-authored contract, verified by tests (not generated from code)

## Status
Accepted

## Context
`openapi.yaml` is the authoritative API contract and is hand-maintained, so it can drift from
the code. We want a public, interactive API reference that is trustworthy. Options: (a) generate
the spec from code; (b) contract-test the hand-authored spec; (c) lint/route-coverage only.

## Decision
Keep `openapi.yaml` hand-authored and **enforce its truth in CI**:
1. `redocly lint` — structural validity (already in CI).
2. Response contract test — real responses validated against documented JSON schemas (ajv 2020).
3. Bidirectional route↔spec coverage — every Express route is documented and vice-versa.
Generation-from-code is rejected: it would refactor every route and lose the readable, reviewable
hand-authored spec, for a marginal gain over (2)+(3).

## Scope of the guarantee
Enforcement covers **JSON response bodies** for covered/allowlisted operations. It does NOT cover
request bodies, negative inputs, headers/content-negotiation, or binary/multipart media types
(e.g. the DOCX `generate` endpoints). These are explicit, tracked gaps — not silent coverage.

## Consequences
- New endpoints must be documented or CI fails (coverage gate).
- Documented responses cannot silently drift for covered ops.
- A response allowlist tracks not-yet-verified ops; it is burned down over time.
- Future option held in reserve: `express-openapi-validator` for wholesale response validation.
```

- [ ] **Step 2: Commit (closes PR1)**

```bash
git add docs/adr/026-openapi-contract-testing.md
git commit -m "docs(adr): ADR-026 — contract-test openapi.yaml, do not generate from code

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **PR1 boundary:** open a PR for Tasks 1–4 (`feat(api): contract + coverage gate for openapi.yaml`). Link the tracking issue. Let CI go green; do not merge (PR-only).

---

### Task 5: Burn down the response allowlist (iterative — PR2…N)

**Files:**
- Modify: `src/api/contract.integration.test.ts` (move entries `RESPONSE_ALLOWLIST` → `RESPONSE_COVERED`, add assertions)

**This task repeats per route-group.** Each iteration is a small PR. Data-dependent endpoints need fixtures — mirror the setup already used in the matching integration test (e.g. `src/api/specs.integration.test.ts` for specs, `src/api/projects.integration.test.ts` for projects).

- [ ] **Step 1: Pick a route group** (e.g. `get /specs/{}`, `get /specs/{}/lineage`).

- [ ] **Step 2: Add a response assertion using real fixtures**

Pattern (specs group shown — copy the fixture/seed setup from `src/api/specs.integration.test.ts`):

```typescript
it('GET /specs/{id} matches its documented 200 schema', async () => {
  const specId = await seedSpecFixture() // reuse the helper/pattern from specs.integration.test.ts
  const res = await fetch(`${baseUrl}/specs/${specId}`)
  expect(res.status).toBe(200)
  await assertResponse('get', '/specs/{id}', 200, await res.json())
})
```

- [ ] **Step 3: Move the op from allowlist to covered**

Delete its entry from `RESPONSE_ALLOWLIST`; add the normalized form to `RESPONSE_COVERED`.

- [ ] **Step 4: Run**

Run: `pnpm test:integration -- contract`
Expected: PASS. If the body fails validation, the **spec or the code is wrong** — fix the genuine mismatch (`systematic-debugging`), pinning a regression test named for the symptom; do not loosen the schema to force green.

- [ ] **Step 5: Commit**

```bash
git add src/api/contract.integration.test.ts   # + any spec/code fix
git commit -m "test(api): verify <route group> responses; shrink allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Repeat until `RESPONSE_ALLOWLIST` is empty. (Backlog = the 38 entries seeded in Task 3.)

---

### Task 6: Vendor the Scalar bundle

**Files:**
- Modify: `package.json` (dep + `vendor:scalar` script)
- Create: `src/api/docs-assets.ts`
- Create: `scripts/vendor-scalar.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `vendorScalarAssets(): string` (copies bundle, returns the served dir) and `SCALAR_DIR` constant.

- [ ] **Step 1: Install pinned Scalar**

```bash
pnpm add -D @scalar/api-reference
pnpm audit --prod   # expect clean; confirm MIT
```

- [ ] **Step 2: Implement the asset resolver**

Create `src/api/docs-assets.ts`:

```typescript
import { createRequire } from 'node:module'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
export const SCALAR_DIR = join(process.cwd(), 'public', 'scalar')

const ASSETS = ['dist/browser/standalone.min.js'] as const

export function vendorScalarAssets(): string {
  const pkgRoot = dirname(require.resolve('@scalar/api-reference/package.json'))
  mkdirSync(SCALAR_DIR, { recursive: true })
  for (const asset of ASSETS) {
    cpSync(join(pkgRoot, asset), join(SCALAR_DIR, asset.split('/').pop() ?? asset))
  }
  return SCALAR_DIR
}
```

- [ ] **Step 3: Add the CLI wrapper + npm script**

Create `scripts/vendor-scalar.ts`:

```typescript
import { vendorScalarAssets } from '../src/api/docs-assets.js'

const dir = vendorScalarAssets()
console.log(`vendored Scalar standalone bundle -> ${dir}`)
```

In `package.json` `scripts`, add: `"vendor:scalar": "tsx scripts/vendor-scalar.ts"`.

- [ ] **Step 4: Ignore the build artifact**

Add `public/` to `.gitignore`.

- [ ] **Step 5: Verify the copy**

Run: `pnpm vendor:scalar && ls -la public/scalar/`
Expected: `standalone.min.js` and `style.min.css` present.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/api/docs-assets.ts scripts/vendor-scalar.ts .gitignore
git commit -m "build(api): vendor pinned Scalar standalone bundle (no CDN)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Serve the Scalar reference at /docs

**Files:**
- Create: `src/api/docs.ts`
- Modify: `src/index.ts` (mount before `errorHandler`)
- Create (test): `src/api/docs.integration.test.ts`

**Interfaces:**
- Consumes: `SCALAR_DIR`, `vendorScalarAssets` (Task 6).
- Produces: `registerDocsRoutes(app: Express): void`.

- [ ] **Step 1: Write the failing integration test**

Create `src/api/docs.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { registerDocsRoutes } from './docs.js'
import { vendorScalarAssets } from './docs-assets.js'

let server: Server
let baseUrl: string

beforeAll(async () => {
  vendorScalarAssets() // ensure the bundle exists for the static route
  const app = express()
  registerDocsRoutes(app)
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 3000
  baseUrl = `http://localhost:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

describe('GET /docs (Scalar reference)', () => {
  it('serves an HTML page that boots Scalar', async () => {
    const res = await fetch(`${baseUrl}/docs`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('createApiReference')
  })

  it('serves the vendored bundle as JavaScript', async () => {
    const res = await fetch(`${baseUrl}/docs/scalar.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
  })

  it('serves the OpenAPI document', async () => {
    const res = await fetch(`${baseUrl}/openapi.yaml`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('openapi: 3.1')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- docs.integration`
Expected: FAIL — `Cannot find module './docs.js'`.

- [ ] **Step 3: Implement the docs routes**

Create `src/api/docs.ts`:

```typescript
import { join } from 'node:path'
import type { Express, Request, Response } from 'express'
import { SCALAR_DIR } from './docs-assets.js'

const OPENAPI_PATH = join(process.cwd(), 'openapi.yaml')

const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SpecR API Reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="/docs/scalar.js"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.yaml' })
    </script>
  </body>
</html>`

export function registerDocsRoutes(app: Express): void {
  app.get('/docs', (_req: Request, res: Response) => {
    res.type('html').send(PAGE)
  })
  app.get('/docs/scalar.js', (_req: Request, res: Response) => {
    res.type('application/javascript').sendFile(join(SCALAR_DIR, 'standalone.min.js'))
  })
  app.get('/openapi.yaml', (_req: Request, res: Response) => {
    res.type('text/yaml').sendFile(OPENAPI_PATH)
  })
}
```

- [ ] **Step 4: Mount in the app**

In `src/index.ts`, import `registerDocsRoutes` and call `registerDocsRoutes(app)` after `app.use(router)` and before `app.use(errorHandler)`. Add `"predev": "pnpm vendor:scalar"` to `package.json` scripts so `pnpm dev` always has the bundle.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test:integration -- docs.integration && pnpm lint`
Expected: PASS (3 tests), lint clean.

- [ ] **Step 6: Manual check**

Run: `pnpm dev`, open `http://localhost:3000/docs`. Confirm the reference renders and "Try-it" on `GET /health` executes (same-origin, no CORS).

- [ ] **Step 7: Commit (PR3)**

```bash
git add src/api/docs.ts src/api/docs.integration.test.ts src/index.ts package.json
git commit -m "feat(api): serve Scalar API reference at /docs + /openapi.yaml

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Publish to GitHub Pages, gated on CI

**Files:**
- Modify: `openapi.yaml` (`servers:` placeholder)
- Create: `docs/site/index.html` (relative-path page for Pages)
- Create: `.github/workflows/docs.yml`

- [ ] **Step 1: Add a hosted-server placeholder**

In `openapi.yaml`, under `servers:`, keep localhost and add (commented):

```yaml
servers:
  - url: http://localhost:3000
    description: Local development server
  # - url: https://specr.example.com   # hosted instance — uncomment when #43 (auth) lands
  #   description: Hosted instance
```

Run: `pnpm exec redocly lint openapi.yaml` → expect no new errors.

- [ ] **Step 2: Add the Pages page (relative paths)**

Create `docs/site/index.html` — identical to the `/docs` page but with **relative** asset URLs so it works under the `/SpecR/` Pages base path:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SpecR API Reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="./scalar/standalone.min.js"></script>
    <script>
      Scalar.createApiReference('#app', { url: './openapi.yaml' })
    </script>
  </body>
</html>
```

- [ ] **Step 3: Create the gated workflow**

Create `.github/workflows/docs.yml`:

```yaml
name: Docs

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' || github.event_name == 'workflow_dispatch' }}
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}

      - uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8
        with:
          version: "11"

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "22"
          cache: "pnpm"

      - run: pnpm install --frozen-lockfile

      - name: Validate the contract
        run: pnpm exec redocly lint openapi.yaml

      - name: Assemble docs-site/
        run: |
          mkdir -p docs-site/scalar
          pnpm vendor:scalar
          cp public/scalar/*.min.* docs-site/scalar/
          cp docs/site/index.html docs-site/index.html
          cp openapi.yaml docs-site/openapi.yaml

      - uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0

      - uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: docs-site

      - id: deploy
        uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0
```

- [ ] **Step 4: Enable Pages**

In the GitHub repo: Settings → Pages → Source = "GitHub Actions". (One-time, manual.)

- [ ] **Step 5: Commit (PR4)**

```bash
git add openapi.yaml docs/site/index.html .github/workflows/docs.yml
git commit -m "ci: publish Scalar API reference to Pages after CI succeeds on main

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Manual verification (after PR4 merges to main)**

Trigger `Docs` via `workflow_dispatch` (or let it run on the next CI success). Confirm: the run only deploys when CI concluded `success`; the published `https://<owner>.github.io/SpecR` renders the reference and reflects the current `openapi.yaml`.

---

## Self-Review

**Spec coverage:**
- Decision 1 (contract-test truth model) → Tasks 2, 3, 4 (+ ADR). ✓
- Decision 2 (local-now/hosted-ready Try-it) → Task 7 (`/docs` same-origin) + Task 8 Step 1 (server placeholder). ✓
- Decision 3 (Scalar, vendored bundle) → Tasks 6, 7. ✓
- Bidirectional route↔spec coverage (Finding 2) → Task 3 structural test. ✓
- Scope-of-guarantee / non-JSON gaps (Finding 3) → `assertResponse` no-ops non-JSON; ADR scope section; allowlist. ✓
- Declared pinned deps, not transitive (Finding 4) → Task 1. ✓
- Vendored Scalar, no CDN/bundler (Finding 5) → Task 6. ✓
- Corrected `/docs` rationale (Finding 6) → spec already fixed; plan serves same-origin `/docs`. ✓
- `contents: read` (Finding 7) → Task 8 workflow `permissions`. ✓
- Helper under `src/` (Finding 8) → `src/test-utils/contract/`; coverage exclude. ✓
- CI-gated publish (Finding 1) → Task 8 `workflow_run` + `if: conclusion == 'success'`. ✓
- PR1 discovery+allowlist, not "test-only" (Finding 9) → Tasks 1–4 land deps+gate with allowlist; Task 5 burns down. ✓

**Placeholder scan:** No TBD/TODO. All code blocks complete; SHAs and the 38-entry allowlist are concrete. ✓

**Type consistency:** `assertResponse`, `expressRouteManifest`, `specOperationManifest`, `successJsonOps`, `loadSpec`, `vendorScalarAssets`, `SCALAR_DIR`, `registerDocsRoutes` are named identically where defined (Tasks 2, 6, 7) and consumed (Tasks 3, 5, 7). ✓
