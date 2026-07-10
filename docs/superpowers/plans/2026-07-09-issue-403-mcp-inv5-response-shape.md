# MCP INV-5 tool response-shape validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ADR-044 response-shape gap by adding INV-5 to the MCP contract gate — validating each driven user-facing MCP tool's output against its mapped REST op's OpenAPI success-response schema, with an explicit burn-down for reads not yet driven and reasoned exemptions for tools that legitimately reshape.

**Architecture:** MCP tool handlers return the *bare* `data` payload; REST responses wrap it as `{ success: true, data }` (`SuccessResponse` = `{ success: true }` only). So INV-5 reconstructs the envelope — `{ success: true, data: <parsed tool payload> }` — and validates it with the **existing** `assertResponse` REST validator (no fork). Coverage is a burn-down mirroring ADR-044's own `MCP_UNEXPOSED`: driven reads are validated live; reads awaiting a fixture graph are tracked in `INV5_READ_PENDING`; tools whose output legitimately reshapes are tracked in `INV5_SHAPE_EXEMPT` with reasons. A completeness invariant asserts every read-mapped tool sits in exactly one bucket, so no tool can drift silently.

**Tech Stack:** TypeScript (ESM, strict + noUncheckedIndexedAccess), Vitest (unit + integration projects), ajv 2020 (via `test-utils/contract/validate-response.ts`), `@modelcontextprotocol/sdk`.

## Global Constraints

- ESLint: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10 (NOT relaxed in tests), `no-console` off in tests, `max-lines`/`max-lines-per-function` off in `src/**/*.test.ts` but enforced (400 / 50) in non-test `src/**`.
- No `any`, no `as unknown as`, no non-null `!` in non-test code (allowed in tests). Use `z.uuid()` not `z.string().uuid()`.
- ESM: relative imports carry `.js`; `import type` for type-only imports (`verbatimModuleSyntax`).
- MCP DB imports come from `../db/index.js` only. MCP tools never throw.
- `openapi.yaml` is authoritative — do NOT edit unless genuine drift is found.
- Commits: Conventional Commits, scope = `mcp`. End every commit body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- INV-5 invocation + completeness assertions live in `src/mcp/contract.integration.test.ts` (needs Postgres + `pnpm migrate && pnpm seed`). The teeth/guard + envelope-wrap unit assertions live in `src/test-utils/contract/validate-response.test.ts` (no DB).

---

### Task 1: Add `INV5_SHAPE_EXEMPT` and `INV5_READ_PENDING` maps to `contract-map.ts`

**Files:**
- Modify: `src/mcp/contract-map.ts` (append two exports after `MCP_NATIVE`)

**Interfaces:**
- Produces:
  - `export const INV5_SHAPE_EXEMPT: ReadonlyMap<string /*tool*/, string /*reason*/>` — tools whose success output legitimately reshapes vs. the REST body 1:1.
  - `export const INV5_READ_PENDING: ReadonlySet<string /*tool*/>` — read tools that mirror their REST op but are not yet driven by INV-5 (burn-down; each needs a fixture graph). ADR-044-style burn-down list.

- [ ] **Step 1: Add the two maps.** `INV5_SHAPE_EXEMPT` has one real entry (`get_spec`); `INV5_READ_PENDING` holds the GET-mapped read tools not in the driven set. Reason strings are honest and specific.

```ts
/**
 * Tools whose success output legitimately RESHAPES its mapped REST op's body — it does not
 * return the REST `data` 1:1, so INV-5 does not schema-validate it against that op. Each entry
 * carries a reason, mirroring how MCP_UNEXPOSED documents coverage exemptions. Never silent.
 */
export const INV5_SHAPE_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'get_spec',
    'reshapes: returns { tree, references } nested plus MCP _meta navigation anchors, whereas ' +
      'REST GET /specs/{id} returns the flattened spec tree with styleSource/onboardingStatus/' +
      'withdrawnAt at top level — deliberately different agent-facing shape, not the REST body 1:1.',
  ],
]);

/**
 * Read tools that DO mirror their mapped REST op's body but are not yet driven by INV-5 because
 * they need a seeded fixture graph (a parsed spec, a project, a template, …) beyond `pnpm seed`.
 * This is a burn-down list — the same posture ADR-044 takes with MCP_UNEXPOSED's `pending` entries:
 * entries graduate into INV5's driven set as fixtures land. INV-5's completeness invariant proves
 * no read-mapped tool is silently absent from both the driven set and these two maps.
 */
export const INV5_READ_PENDING: ReadonlySet<string> = new Set([
  'get_spec_lineage',
  'get_hierarchy_report',
  'coordination_report',
  'get_project_keynotes',
  'list_revit_links',
  'open_comments_report',
  'get_project',
  'list_associations',
  'get_spec_lock',
  'get_template',
  'get_library_conventions',
  'get_required_sections',
  'get_package_required_sections',
  'get_project_revision_nomenclature',
  'list_library_numbering_profiles',
  'get_numbering_profile_by_id',
  'list_library_specs',
  'get_library_general_spec',
  'get_project_general_spec',
  'list_packages',
  'list_package_revisions',
  'get_revision',
  'get_client',
]);
```

- [ ] **Step 2: Typecheck.** Run: `pnpm exec tsc --noEmit` — Expected: PASS (no unused, types resolve).

- [ ] **Step 3: Commit.**

```bash
git add src/mcp/contract-map.ts
git commit -m "feat(mcp): INV-5 shape-exempt + read-pending burn-down maps"
```

---

### Task 2: Envelope-wrap teeth (unit test, no DB) in `validate-response.test.ts`

**Files:**
- Modify: `src/test-utils/contract/validate-response.test.ts`

**Interfaces:**
- Consumes: `assertResponse(method, pathTemplate, status, body)` from `./validate-response.js` (existing).

- [ ] **Step 1: Write the failing/guard tests.** These prove the envelope-wrap approach has teeth: a malformed `data` fails; a well-formed `data` passes. Pure — reads only `openapi.yaml`.

```ts
describe('INV-5 envelope-wrap reuse (assertResponse teeth)', () => {
  it('rejects a malformed enveloped tool payload', async () => {
    // GET /projects data is an array of ProjectListItem — a string must fail.
    await expect(
      assertResponse('get', '/projects', 200, { success: true, data: 'not-an-array' })
    ).rejects.toThrow(/does not match openapi/i);
  });

  it('accepts a well-formed enveloped tool payload', async () => {
    await expect(
      assertResponse('get', '/projects', 200, { success: true, data: [] })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run.** `pnpm test -- validate-response` — Expected: both PASS (this is a guard, not red-first; it proves the mechanism INV-5 relies on).

- [ ] **Step 3: Commit.**

```bash
git add src/test-utils/contract/validate-response.test.ts
git commit -m "test(mcp): INV-5 envelope-wrap teeth for assertResponse"
```

---

### Task 3: INV-5 driven-tool validation (integration) in `contract.integration.test.ts`

**Files:**
- Modify: `src/mcp/contract.integration.test.ts`

**Interfaces:**
- Consumes: `assertResponse` (validator); `OP_TO_TOOL`, `INV5_SHAPE_EXEMPT`, `INV5_READ_PENDING` (contract-map); the six list handlers.
- Produces: an inline `INV5_DRIVEN` case table `{ tool, method, path, status, invoke }`.

- [ ] **Step 1: Add imports and the driven-case table.** All six handlers return `ok(await listX())`; each REST route returns `{ success: true, data: <same listX()> }`, so `{ success: true, data: <parsed payload> }` is byte-identical to the REST body already validated by the REST contract gate — correct by construction.

```ts
import { handleListLibraries, handleListProjects } from './handlers.js';
import { handleListTemplates } from './template-handlers.js';
import { handleListConventions } from './convention-handlers.js';
import { handleListRevisionNomenclatureProfiles } from './revision-nomenclature-handlers.js';
import { handleListClients } from './clients-handlers.js';
import { INV5_SHAPE_EXEMPT, INV5_READ_PENDING } from './contract-map.js';
import type { ToolResult } from './tool-result.js';

interface DrivenCase {
  readonly tool: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly invoke: () => Promise<ToolResult>;
}

// Seed-only reads whose handler returns the bare service output the REST route wraps as `data`.
const INV5_DRIVEN: readonly DrivenCase[] = [
  { tool: 'list_projects', method: 'get', path: '/projects', status: 200, invoke: handleListProjects },
  { tool: 'list_libraries', method: 'get', path: '/libraries', status: 200, invoke: handleListLibraries },
  { tool: 'list_templates', method: 'get', path: '/templates', status: 200, invoke: handleListTemplates },
  { tool: 'list_conventions', method: 'get', path: '/conventions', status: 200, invoke: handleListConventions },
  {
    tool: 'list_revision_nomenclature_profiles',
    method: 'get',
    path: '/revision-nomenclature-profiles',
    status: 200,
    invoke: handleListRevisionNomenclatureProfiles,
  },
  { tool: 'list_clients', method: 'get', path: '/clients', status: 200, invoke: handleListClients },
];

function parsePayload(res: ToolResult): unknown {
  if ('isError' in res) throw new Error(`tool errored: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}
```

- [ ] **Step 2: Add the INV-5 driven validation test** inside the existing `describe('MCP contract (REST <-> MCP parity)', ...)`.

```ts
it.each(INV5_DRIVEN)(
  'INV-5: $tool output validates against its mapped op response schema',
  async ({ method, path, status, invoke }) => {
    const payload = parsePayload(await invoke());
    await assertResponse(method, path, status, { success: true, data: payload });
  }
);
```

- [ ] **Step 3: Run integration** (needs Postgres + seed):

```bash
docker compose up -d postgres && pnpm migrate && pnpm seed && \
  pnpm test:integration -- contract.integration
```
Expected: PASS. If Postgres is unavailable in this environment, skip execution and note it in the PR (the test is correct-by-construction — each driven payload is the REST route's own `data`).

- [ ] **Step 4: Commit.**

```bash
git add src/mcp/contract.integration.test.ts
git commit -m "test(mcp): INV-5 drives seed-only read tools through the response validator"
```

---

### Task 4: INV-5 completeness + exemption-realness invariants (integration)

**Files:**
- Modify: `src/mcp/contract.integration.test.ts`

**Interfaces:**
- Consumes: `OP_TO_TOOL`, `INV5_SHAPE_EXEMPT`, `INV5_READ_PENDING`, `declaredToolNames()` (existing helper in file), `INV5_DRIVEN`.

- [ ] **Step 1: Add a helper deriving the read-mapped tool universe** (GET ops in `OP_TO_TOOL`). Place near the top of the file.

```ts
function readMappedTools(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [op, tool] of OP_TO_TOOL) if (op.startsWith('get ')) out.add(tool);
  return out;
}
```

- [ ] **Step 2: Add completeness invariant** — every read-mapped tool is driven, shape-exempt, or pending (exactly one). This is INV-5's "no silent gap", mirroring INV-1.

```ts
it('INV-5 completeness: every read-mapped tool is driven, shape-exempt, or pending', () => {
  const driven = new Set(INV5_DRIVEN.map((c) => c.tool));
  const uncovered = [...readMappedTools()]
    .filter((t) => !driven.has(t) && !INV5_SHAPE_EXEMPT.has(t) && !INV5_READ_PENDING.has(t))
    .sort((a, b) => a.localeCompare(b));
  expect(uncovered, 'read tools absent from INV5 driven/exempt/pending buckets').toEqual([]);
});
```

- [ ] **Step 3: Add exemption/pending realness** — every exempt/pending key is a real registered tool; every exemption carries a non-empty reason. Mirrors the existing MCP_UNEXPOSED disjoint+real test.

```ts
it('INV-5: shape-exempt + read-pending reference real tools; exemptions carry a reason', () => {
  const declared = new Set(declaredToolNames());
  for (const [tool, reason] of INV5_SHAPE_EXEMPT) {
    expect(declared.has(tool), `${tool} not a registered tool`).toBe(true);
    expect(reason.trim().length, `${tool} exemption needs a reason`).toBeGreaterThan(0);
  }
  for (const tool of INV5_READ_PENDING)
    expect(declared.has(tool), `${tool} not a registered tool`).toBe(true);
});
```

- [ ] **Step 4: Add disjointness** — a tool is never both driven and skipped, nor in both skip buckets (prevents contradictory bookkeeping).

```ts
it('INV-5: driven, shape-exempt, and read-pending buckets are disjoint', () => {
  const driven = new Set(INV5_DRIVEN.map((c) => c.tool));
  for (const t of driven) {
    expect(INV5_SHAPE_EXEMPT.has(t), `${t} both driven and shape-exempt`).toBe(false);
    expect(INV5_READ_PENDING.has(t), `${t} both driven and pending`).toBe(false);
  }
  for (const t of INV5_SHAPE_EXEMPT.keys())
    expect(INV5_READ_PENDING.has(t), `${t} both shape-exempt and pending`).toBe(false);
});
```

- [ ] **Step 5: Run** `pnpm lint` (eslint + tsc + prettier) and, if Postgres available, `pnpm test:integration -- contract.integration`. Expected: lint PASS; integration PASS or documented-skipped.

- [ ] **Step 6: Commit.**

```bash
git add src/mcp/contract.integration.test.ts
git commit -m "test(mcp): INV-5 completeness, realness, and disjointness invariants"
```

---

### Task 5: Mark the ADR-044 response-shape gap CLOSED

**Files:**
- Modify: `docs/adr/044-mcp-contract-testing.md` (§79–81 Consequences bullet + add INV-5 to the Decision list)

**Interfaces:** none (docs).

- [ ] **Step 1: Update the Decision INV list** to add INV-5 and update the trailing Consequences bullet that currently calls response-shape "a tracked future gap." Replace it with prose stating INV-5 closes it via the envelope-wrap reuse + burn-down, and note the burn-down (`INV5_READ_PENDING`) and reshape exemptions (`INV5_SHAPE_EXEMPT`).

- [ ] **Step 2: Verify** no stale "future gap" phrasing remains: `grep -n "future gap\|response.*shape" docs/adr/044-mcp-contract-testing.md`.

- [ ] **Step 3: Commit.**

```bash
git add docs/adr/044-mcp-contract-testing.md
git commit -m "docs(adr): mark ADR-044 response-shape gap closed by INV-5"
```

---

## Self-Review

**Spec coverage:** Design deliverables → tasks: INV-5 test in contract.integration.test.ts (Tasks 3–4); `INV5_SHAPE_EXEMPT` with reasons (Task 1); ADR-044 update (Task 5). Design invariants: (1) driven-tool output validates → Task 3; (2) exemptions real + reasoned → Task 4 Step 3; (3) malformed payload fails → Task 2. Added beyond the design (flagged in PR): `INV5_READ_PENDING` burn-down + completeness/disjointness invariants — honest handling of reads not driveable without a fixture graph, mirroring ADR-044's MCP_UNEXPOSED burn-down.

**Placeholder scan:** none — all code is concrete.

**Type consistency:** `INV5_DRIVEN` case shape (`tool/method/path/status/invoke`) used identically in Tasks 3–4; `readMappedTools`/`declaredToolNames` names stable; handler names match `handlers.ts`/`*-handlers.ts` exports.

**Scope deviation flagged:** INV-5 is scoped to READ-mapped (GET) tools; write/destructive tools are out of INV-5's scope (their success payload is a mutation result; request contract already pinned by INV-4). Documented in the ADR and PR body.
