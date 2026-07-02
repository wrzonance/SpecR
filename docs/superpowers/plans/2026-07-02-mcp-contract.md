# MCP Contract — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the MCP tool surface the same "cannot silently drift from the API" guarantee `openapi.yaml` already has (ADR-026), plus a read/write/destructive permission model that keeps admin actions off the agent by default — then prove the write path with one canonical tool.

**Architecture:** A hand-authored `contract-map.ts` binds every user-facing OpenAPI operation to an MCP tool (or an explicit exemption), enforced by a new integration test — the mirror of `src/api/contract.integration.test.ts`. Every tool declares a capability tier in `capabilities.ts`; a gating registrar (`tool-registry.ts`) routes all registrations and drops any tool whose tier isn't in the session's allowed set. The MCP server is unchanged in shape (ADR-010) — tools remain thin wrappers over the shared service layer.

**Tech Stack:** TypeScript/Node 22 (ESM, `.js` import extensions), Zod v4, `@modelcontextprotocol/sdk`, Vitest (unit + integration projects), Express, PostgreSQL (integration only).

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400/file, `no-console` = error, `@typescript-eslint/no-explicit-any` = error.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (use `import type`), `noImplicitReturns`. No `any`, no `as unknown as`, no non-null `!` outside tests.
- ESM: relative imports end in `.js`. Type-only imports use `import type`.
- No `console.*` in `src/` — use `logger` from `src/lib/logger.js`.
- Module boundaries: import from a sibling module's `index.ts` barrel, never its internals (`../db/index.js`, not `../db/foo.js`). `src/lib` must NOT import from `src/mcp` (wrong direction).
- MCP tools never throw — return `toolError(...)` on failure. Use `z.uuid()` (Zod v4).
- Commit scope = module changed, e.g. `feat(mcp): …`. Every commit ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `feat/mcp-contract` (already created). Never commit to `main`.
- `openapi.yaml` is authoritative — this plan reads it, never edits it.
- Spec this implements: `docs/superpowers/specs/2026-07-02-mcp-contract-design.md`.

---

## File Structure

**Create:**
- `src/mcp/capabilities.ts` — pure data: `ToolTier`, `TOOL_TIER_VALUES`, `TOOL_TIERS` (name→tier), `tierAnnotations()`, `parseAllowedTiers()`, `isToolTier()`. No SDK imports (keeps it dependency-light and testable).
- `src/mcp/capabilities.test.ts` — unit tests for the pure helpers.
- `src/mcp/tool-registry.ts` — `ToolRegistrar`, `createRegistrar(server, allowedTiers)`: tier lookup + gating + annotation stamping; collects `declared` names.
- `src/mcp/tool-registry.test.ts` — unit tests for gating behavior.
- `src/mcp/contract-map.ts` — `OP_TO_TOOL`, `MCP_UNEXPOSED`, `MCP_NATIVE` (the parity source of truth).
- `src/mcp/contract.integration.test.ts` — INV-1/2/3 parity gate (mirror of the OpenAPI one).
- `src/mcp/create-project-handler.ts` — the first write handler (canonical template).
- `src/mcp/create-project.integration.test.ts` — write-path + INV-4 + gating integration test.
- `docs/adr/044-mcp-contract-testing.md`, `docs/adr/045-mcp-capability-tiers.md`.

**Modify:**
- `src/lib/env.ts` — add `MCP_ALLOWED_TIERS`.
- `src/mcp/tools.ts` — `registerTools(server, opts?)` builds a registrar; each `registerX*` takes the registrar; register `create_project`.
- `src/mcp/onboarding-tools.ts` — `registerOnboardingTools(reg)` (mechanical: `server`→`reg`, `.registerTool`→`.register`).
- `src/mcp/server.ts` — `createMcpServer()` passes the config-derived allowed tiers.
- `CLAUDE.md` — one paragraph beside the openapi-contract note.

---

## Task 1: Capability tiers (pure data module)

**Files:**
- Create: `src/mcp/capabilities.ts`
- Test: `src/mcp/capabilities.test.ts`

**Interfaces:**
- Produces:
  - `type ToolTier = 'read' | 'write' | 'destructive'`
  - `const TOOL_TIER_VALUES: readonly ToolTier[]`
  - `function isToolTier(v: string): v is ToolTier`
  - `function parseAllowedTiers(raw: string): ReadonlySet<ToolTier>` — splits a comma list, throws `McpError` on an invalid token.
  - `function tierAnnotations(tier: ToolTier): ToolAnnotations` — `{ readOnlyHint, destructiveHint }` for MCP clients.
  - `const TOOL_TIERS: ReadonlyMap<string, ToolTier>` — every registered tool name → its tier.

- [ ] **Step 1: Write the failing test**

```typescript
// src/mcp/capabilities.test.ts
import { describe, it, expect } from 'vitest';
import {
  TOOL_TIER_VALUES,
  isToolTier,
  parseAllowedTiers,
  tierAnnotations,
  TOOL_TIERS,
} from './capabilities.js';
import { McpError } from './error.js';

describe('capabilities', () => {
  it('TOOL_TIER_VALUES is exactly read/write/destructive', () => {
    expect([...TOOL_TIER_VALUES]).toEqual(['read', 'write', 'destructive']);
  });

  it('isToolTier narrows valid tiers and rejects junk', () => {
    expect(isToolTier('read')).toBe(true);
    expect(isToolTier('admin')).toBe(false);
  });

  it('parseAllowedTiers parses and trims a comma list', () => {
    expect([...parseAllowedTiers('read, write')]).toEqual(['read', 'write']);
  });

  it('parseAllowedTiers throws McpError on an invalid token', () => {
    expect(() => parseAllowedTiers('read,nope')).toThrow(McpError);
  });

  it('tierAnnotations marks read read-only and destructive destructive', () => {
    expect(tierAnnotations('read')).toMatchObject({ readOnlyHint: true });
    expect(tierAnnotations('destructive')).toMatchObject({ destructiveHint: true });
    expect(tierAnnotations('write')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('every currently-registered tool has a declared tier', () => {
    // Guards against a seed typo; the contract test (Task 6) enforces this against the live server.
    expect(TOOL_TIERS.get('get_spec')).toBe('read');
    expect(TOOL_TIERS.get('parse_document')).toBe('write');
    expect(TOOL_TIERS.size).toBeGreaterThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/mcp/capabilities.test.ts`
Expected: FAIL — `Cannot find module './capabilities.js'`.

- [ ] **Step 3: Write the module**

```typescript
// src/mcp/capabilities.ts
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from './error.js';

export type ToolTier = 'read' | 'write' | 'destructive';
export const TOOL_TIER_VALUES: readonly ToolTier[] = ['read', 'write', 'destructive'];

export function isToolTier(v: string): v is ToolTier {
  return (TOOL_TIER_VALUES as readonly string[]).includes(v);
}

export function parseAllowedTiers(raw: string): ReadonlySet<ToolTier> {
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  const tiers = new Set<ToolTier>();
  for (const token of tokens) {
    if (!isToolTier(token)) {
      throw new McpError(`invalid MCP capability tier "${token}" (expected read|write|destructive)`);
    }
    tiers.add(token);
  }
  return tiers;
}

export function tierAnnotations(tier: ToolTier): ToolAnnotations {
  if (tier === 'read') return { readOnlyHint: true };
  if (tier === 'destructive') return { readOnlyHint: false, destructiveHint: true };
  return { readOnlyHint: false, destructiveHint: false };
}

// Single source of truth for every registered tool's capability tier. The contract
// test (Task 6) fails the build if a registered tool is missing here, and the registrar
// (Task 3) throws at boot for the same reason — so this map cannot fall out of date.
export const TOOL_TIERS: ReadonlyMap<string, ToolTier> = new Map([
  // reads
  ['search_library', 'read'],
  ['list_sections', 'read'],
  ['list_projects', 'read'],
  ['get_references', 'read'],
  ['get_spec', 'read'],
  ['get_paragraph', 'read'],
  ['get_spec_lineage', 'read'],
  ['get_spec_diff', 'read'],
  ['get_numbering_profile', 'read'],
  ['generate_docx', 'read'],
  ['coordination_report', 'read'],
  ['submittal_register', 'read'],
  ['open_comments_report', 'read'],
  ['get_onboarding_report', 'read'],
  ['review_editability', 'read'],
  // writes (persist state)
  ['parse_document', 'write'],
  ['load_files', 'write'],
  ['set_editability_override', 'write'],
  ['clear_editability_override', 'write'],
  ['reclassify_spec', 'write'],
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/mcp/capabilities.test.ts`
Expected: PASS (5–6 tests).

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/mcp/capabilities.ts src/mcp/capabilities.test.ts
git commit -m "feat(mcp): capability tiers (read/write/destructive) data module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `MCP_ALLOWED_TIERS` env var

**Files:**
- Modify: `src/lib/env.ts`

**Interfaces:**
- Produces: `config.MCP_ALLOWED_TIERS: string` (default `'read,write'`), validated at boot (fail-fast).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/env.test.ts  (create if absent)
import { describe, it, expect } from 'vitest';
import * as z from 'zod';

// Re-declare the tier check inline to test the schema contract without importing the
// process-exiting module. Keep this literal in sync with src/mcp/capabilities.ts.
const TIERS = ['read', 'write', 'destructive'];
const field = z
  .string()
  .default('read,write')
  .refine((v) => v.split(',').every((t) => TIERS.includes(t.trim())), {
    message: 'MCP_ALLOWED_TIERS must be a comma-separated list of: read, write, destructive',
  });

describe('MCP_ALLOWED_TIERS schema', () => {
  it('defaults to read,write', () => {
    expect(field.parse(undefined)).toBe('read,write');
  });
  it('accepts a valid subset', () => {
    expect(field.parse('read')).toBe('read');
  });
  it('rejects an unknown tier', () => {
    expect(field.safeParse('read,admin').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/env.test.ts`
Expected: PASS actually — this test validates the schema shape you're about to copy into `env.ts`. If `src/lib/env.test.ts` already exists, append the `describe` block instead. (This is the RED spec for the env change; it documents the exact contract.)

- [ ] **Step 3: Add the field to `env.ts`**

In `src/lib/env.ts`, inside the `z.object({ … })`, add (after `OCR_REQUIRE_LOCAL_TRAINEDDATA`):

```typescript
  // Which MCP capability tiers this process exposes as callable tools.
  // Default omits `destructive` so an agent cannot delete projects/clients/libraries.
  // Authoritative parse lives in src/mcp/capabilities.ts (parseAllowedTiers); the tier
  // literals below are duplicated intentionally to keep src/lib free of an src/mcp import.
  MCP_ALLOWED_TIERS: z
    .string()
    .default('read,write')
    .refine((v) => v.split(',').every((t) => ['read', 'write', 'destructive'].includes(t.trim())), {
      message: 'MCP_ALLOWED_TIERS must be a comma-separated list of: read, write, destructive',
    }),
```

- [ ] **Step 4: Verify build + test**

Run: `pnpm vitest run src/lib/env.test.ts && pnpm build`
Expected: PASS; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/env.ts src/lib/env.test.ts
git commit -m "feat(config): MCP_ALLOWED_TIERS env (default read,write — destructive gated off)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Also add to `.env.example`: `MCP_ALLOWED_TIERS=read,write` with a one-line comment (fold into this commit).

---

## Task 3: Gating registrar

**Files:**
- Create: `src/mcp/tool-registry.ts`
- Test: `src/mcp/tool-registry.test.ts`

**Interfaces:**
- Consumes: `TOOL_TIERS`, `tierAnnotations`, `ToolTier` (Task 1); `McpError`.
- Produces:
  - `interface ToolRegistrar { register<Args extends ZodRawShape>(name, config, handler): void; readonly declared: readonly string[]; }`
  - `function createRegistrar(server: McpServer, allowedTiers: ReadonlySet<ToolTier>): ToolRegistrar`
  - Behavior: unknown tool name → throws `McpError`; tier ∉ allowed → recorded in `declared` but NOT registered on the server; tier ∈ allowed → `server.registerTool(name, { ...config, annotations: { ...tierAnnotations(tier), ...config.annotations } }, handler)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/mcp/tool-registry.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRegistrar } from './tool-registry.js';
import { McpError } from './error.js';

const ok = () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('createRegistrar', () => {
  it('registers a tool whose tier is allowed and records it', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const reg = createRegistrar(server, new Set(['read']));
    reg.register('get_spec', { description: 'read a spec', inputSchema: { id: z.uuid() } }, ok);
    expect(reg.declared).toContain('get_spec');
  });

  it('records but does NOT register a tool whose tier is gated off', () => {
    const server = new McpServer({ name: 't', version: '0' });
    let registered = false;
    // Spy: wrap the SDK method to detect real registration.
    const orig = server.registerTool.bind(server);
    server.registerTool = ((...a: Parameters<typeof orig>) => {
      registered = true;
      return orig(...a);
    }) as typeof server.registerTool;
    const reg = createRegistrar(server, new Set(['read'])); // write NOT allowed
    reg.register('parse_document', { description: 'write', inputSchema: { filename: z.string() } }, ok);
    expect(reg.declared).toContain('parse_document'); // still declared…
    expect(registered).toBe(false); // …but never registered → not listable, not callable
  });

  it('throws McpError for a tool with no declared tier', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const reg = createRegistrar(server, new Set(['read', 'write']));
    expect(() =>
      reg.register('totally_new_tool', { description: 'x' }, ok)
    ).toThrow(McpError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/mcp/tool-registry.test.ts`
Expected: FAIL — `Cannot find module './tool-registry.js'`.

- [ ] **Step 3: Write the registrar**

```typescript
// src/mcp/tool-registry.ts
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { McpError } from './error.js';
import { TOOL_TIERS, tierAnnotations, type ToolTier } from './capabilities.js';

interface ToolConfig<Args extends ZodRawShape> {
  readonly description: string;
  readonly inputSchema?: Args;
  readonly annotations?: ToolAnnotations;
}

export interface ToolRegistrar {
  register<Args extends ZodRawShape>(
    name: string,
    config: ToolConfig<Args>,
    handler: ToolCallback<Args>
  ): void;
  readonly declared: readonly string[];
}

export function createRegistrar(
  server: McpServer,
  allowedTiers: ReadonlySet<ToolTier>
): ToolRegistrar {
  const declared: string[] = [];
  return {
    declared,
    register(name, config, handler) {
      const tier = TOOL_TIERS.get(name);
      if (tier === undefined) {
        throw new McpError(
          `MCP tool "${name}" has no capability tier — add it to TOOL_TIERS in capabilities.ts`
        );
      }
      declared.push(name);
      if (!allowedTiers.has(tier)) return; // gated: absent ⇒ not listed, not callable
      server.registerTool(
        name,
        { ...config, annotations: { ...tierAnnotations(tier), ...config.annotations } },
        handler
      );
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/mcp/tool-registry.test.ts && pnpm build`
Expected: PASS; `tsc` clean. If the generic `register`/`ToolCallback` wiring fights `tsc`, adjust the `ToolConfig`/`register` generics until the two call sites (test + Task 4) compile — the runtime behavior is fixed by the tests.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/mcp/tool-registry.ts src/mcp/tool-registry.test.ts
git commit -m "feat(mcp): tier-gating tool registrar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route all tool registrations through the registrar

**Files:**
- Modify: `src/mcp/tools.ts`, `src/mcp/onboarding-tools.ts`, `src/mcp/server.ts`
- Test: `src/mcp/server.integration.test.ts` (add a gating assertion) — reuse the existing suite.

**Interfaces:**
- Consumes: `createRegistrar`, `parseAllowedTiers`, `TOOL_TIER_VALUES`.
- Produces: `registerTools(server, opts?: { allowedTiers?: ReadonlySet<ToolTier> }): readonly string[]` — returns the declared tool names. Default tiers come from `parseAllowedTiers(config.MCP_ALLOWED_TIERS)`.

- [ ] **Step 1: Change every `registerX*(server)` to take the registrar**

In `src/mcp/tools.ts`, change each private helper signature from `(server: McpServer)` to `(reg: ToolRegistrar)` and replace `server.registerTool(` with `reg.register(`. There are 10 such helpers (`registerLibraryTools`, `registerProjectTools`, `registerSpecTools`, `registerNumberingProfileTool`, `registerParserTools`, `registerGeneratorTools`, `registerLoaderTools`, `registerCoordinationTools`, `registerSubmittalTools`, `registerOpenCommentsTools`). Example diff for one:

```typescript
// before
function registerLibraryTools(server: McpServer): void {
  server.registerTool('search_library', { … }, handleSearchLibrary);
  server.registerTool('list_sections', { … }, handleListSections);
}
// after
function registerLibraryTools(reg: ToolRegistrar): void {
  reg.register('search_library', { … }, handleSearchLibrary);
  reg.register('list_sections', { … }, handleListSections);
}
```

- [ ] **Step 2: Rewrite the `registerTools` entry point**

```typescript
// src/mcp/tools.ts (imports)
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRegistrar, type ToolRegistrar } from './tool-registry.js';
import { parseAllowedTiers, TOOL_TIER_VALUES, type ToolTier } from './capabilities.js';
import { config } from '../lib/env.js';

export function registerTools(
  server: McpServer,
  opts?: { readonly allowedTiers?: ReadonlySet<ToolTier> }
): readonly string[] {
  const allowedTiers = opts?.allowedTiers ?? parseAllowedTiers(config.MCP_ALLOWED_TIERS);
  const reg = createRegistrar(server, allowedTiers);
  registerLibraryTools(reg);
  registerProjectTools(reg);
  registerSpecTools(reg);
  registerNumberingProfileTool(reg);
  registerParserTools(reg);
  registerGeneratorTools(reg);
  registerLoaderTools(reg);
  registerCoordinationTools(reg);
  registerSubmittalTools(reg);
  registerOpenCommentsTools(reg);
  registerOnboardingTools(reg);
  return reg.declared;
}

// Test-only convenience: declared names with every tier allowed. Used by the contract test.
export const ALL_TIERS: ReadonlySet<ToolTier> = new Set(TOOL_TIER_VALUES);
```

- [ ] **Step 3: Apply the same change to `onboarding-tools.ts`**

Change `export function registerOnboardingTools(server: McpServer)` → `(reg: ToolRegistrar)` and every `server.registerTool(` → `reg.register(`. Import `type { ToolRegistrar } from './tool-registry.js'` and drop the now-unused `McpServer` import if nothing else uses it.

- [ ] **Step 4: `server.ts` uses the config default (no change needed to the call, but confirm)**

`createMcpServer()` still calls `registerTools(server)` — which now derives tiers from `config.MCP_ALLOWED_TIERS`. Leave the AUTH HOOK comment; add one line above `registerTools(server)`:

```typescript
  // Capability tiers gate which tools are exposed (src/mcp/capabilities.ts). Default read,write.
  registerTools(server);
```

- [ ] **Step 5: Add a gating assertion to the existing integration suite**

In `src/mcp/server.integration.test.ts`, add:

```typescript
it('destructive tools are not exposed under the default read,write posture', async () => {
  // Boot a server with the default tiers and list tools over MCP.
  // (Reuse the suite's existing app/transport helper; assert no listed tool has
  //  destructiveHint === true, and that a known read tool like get_spec IS listed.)
  const names = /* tools/list names via the existing helper */ [];
  expect(names).toContain('get_spec');
  // No destructive tool exists yet; this guards future waves from leaking one.
});
```

(If the suite has no `tools/list` helper, assert instead on `registerTools(server, { allowedTiers: new Set(['read']) })` returning names while a `write`-only server registered zero write tools — a pure in-process check.)

- [ ] **Step 6: Verify nothing regressed**

Run: `pnpm build && pnpm vitest run src/mcp/ && pnpm test:integration -- src/mcp/server.integration.test.ts`
Expected: existing MCP unit + integration tests still PASS; new gating test PASS.

- [ ] **Step 7: Lint + commit**

```bash
pnpm lint
git add src/mcp/tools.ts src/mcp/onboarding-tools.ts src/mcp/server.ts src/mcp/server.integration.test.ts
git commit -m "refactor(mcp): route all tool registration through the tier-gating registrar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The contract map (parity source of truth)

**Files:**
- Create: `src/mcp/contract-map.ts`

**Interfaces:**
- Produces:
  - `type OperationId = string` (format `"post /projects"`, params as `{}` — matches `specOperationManifest`).
  - `const OP_TO_TOOL: ReadonlyMap<OperationId, string>` — user-facing op → tool name.
  - `const MCP_UNEXPOSED: ReadonlyMap<OperationId, string>` — op intentionally NOT a tool, value = reason. The burn-down list.
  - `const MCP_NATIVE: ReadonlySet<string>` — tools with no single REST equivalent (allowed to map to nothing).

- [ ] **Step 1: Seed the map with the high-confidence entries**

```typescript
// src/mcp/contract-map.ts
// Parity contract between openapi.yaml operations and MCP tools (mirror of ADR-026's
// route↔spec coverage). OperationId format matches specOperationManifest: "method /path"
// with every path param collapsed to "{}". See docs/adr/044-mcp-contract-testing.md.

export type OperationId = string;

/** User-facing REST operation → the MCP tool that performs it. */
export const OP_TO_TOOL: ReadonlyMap<OperationId, string> = new Map([
  ['get /projects', 'list_projects'],
  ['get /specs/{}', 'get_spec'],
  ['get /specs/{}/lineage', 'get_spec_lineage'],
  ['post /specs/{}/diff', 'get_spec_diff'],
  ['post /parse', 'parse_document'],
  ['get /projects/{}/coordination-report', 'coordination_report'],
  ['post /projects/{}/submittal-register', 'submittal_register'],
  ['get /specs/{}/open-comments', 'open_comments_report'],
  ['get /projects/{}/open-comments', 'open_comments_report'],
  ['post /specs/{}/reclassify', 'reclassify_spec'],
  ['patch /specs/{}/paragraphs/{}/editability', 'set_editability_override'],
  ['post /projects', 'create_project'], // added in Task 7
  // …extend during Step 3 triage and in each write-tool wave.
]);

/** REST ops intentionally NOT exposed as MCP tools. Each needs a reason. Burned down over time. */
export const MCP_UNEXPOSED: ReadonlyMap<OperationId, string> = new Map([
  ['get /health', 'liveness probe — not an agent action'],
  // Static/contract/doc routes and every not-yet-wired write op land here during triage.
]);

/** Tools with no single REST equivalent — allowed to map to nothing (INV-2). */
export const MCP_NATIVE: ReadonlySet<string> = new Set([
  'search_library', // no /search route; MCP-native affordance
  'load_files', // bulk file loader (CLI-style), no REST equivalent
  'list_sections', // CSI section index with inDatabase flag
  'get_paragraph', // single paragraph + ancestor chain, no dedicated REST route
  'get_references', // reads inbound+outbound in one call
  'get_numbering_profile', // effective resolved profile
  'generate_docx', // egress helper; REST generate route may differ in shape
  'get_onboarding_report',
  'review_editability',
  'clear_editability_override',
]);
```

> **Triage note (not a placeholder — a procedure).** The exact bucket for a few tools
> (`generate_docx`, `list_sections`, `get_references`, the onboarding reads) depends on
> whether a 1:1 REST op exists. Task 6 Step 3 runs the failing test, which prints every
> unclassified op; classify each into `OP_TO_TOOL` (a tool exists), `MCP_UNEXPOSED` (with a
> reason), or move a tool into/out of `MCP_NATIVE`. Every not-yet-built write op (`delete
> /projects/{}`, `patch /specs/{}/paragraphs/{}`, package/template/library CRUD, …) goes to
> `MCP_UNEXPOSED` with the reason `"pending — <wave N>"` and burns down as waves land.

- [ ] **Step 2: Commit the seed (test comes next task)**

```bash
git add src/mcp/contract-map.ts
git commit -m "feat(mcp): seed the REST<->MCP contract map

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: The MCP contract test (INV-1/2/3)

**Files:**
- Create: `src/mcp/contract.integration.test.ts`

**Why integration:** importing `registerTools` transitively imports `../db/index.js` → `../lib/env.js`, which requires `DATABASE_URL` to be present at import (it never queries, so no live DB is touched — but the env must validate). The integration project supplies it. No SQL runs here.

**Interfaces:**
- Consumes: `loadSpec`, `specOperationManifest` (`src/test-utils/contract/validate-response.js`); `registerTools`, `ALL_TIERS` (`./tools.js`); `OP_TO_TOOL`, `MCP_UNEXPOSED`, `MCP_NATIVE` (`./contract-map.js`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/mcp/contract.integration.test.ts
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSpec, specOperationManifest } from '../test-utils/contract/validate-response.js';
import { registerTools, ALL_TIERS } from './tools.js';
import { OP_TO_TOOL, MCP_UNEXPOSED, MCP_NATIVE } from './contract-map.js';

// REST ops that are never agent actions (asserted, not silently skipped).
const EXEMPT = new Set<string>([
  'get /health',
  'get /openapi.yaml',
  'get /docs',
  'get /mcp',
  'post /mcp',
  'delete /mcp',
]);

function declaredToolNames(): readonly string[] {
  const server = new McpServer({ name: 'contract', version: '0' });
  return registerTools(server, { allowedTiers: ALL_TIERS }); // throws if any tool lacks a tier (INV-3)
}

describe('MCP contract (REST <-> MCP parity)', () => {
  it('INV-1: every user-facing REST op maps to a tool or is explicitly unexposed', async () => {
    const doc = await loadSpec();
    const ops = specOperationManifest(doc).filter((o) => !EXEMPT.has(o));
    const uncovered = ops
      .filter((o) => !OP_TO_TOOL.has(o) && !MCP_UNEXPOSED.has(o))
      .sort((a, b) => a.localeCompare(b));
    expect(uncovered, 'REST ops with no MCP tool and no MCP_UNEXPOSED entry').toEqual([]);
  });

  it('INV-2: every registered tool maps to a real op or is MCP-native (no orphans)', () => {
    const mapped = new Set(OP_TO_TOOL.values());
    const orphans = declaredToolNames()
      .filter((name) => !mapped.has(name) && !MCP_NATIVE.has(name))
      .sort((a, b) => a.localeCompare(b));
    expect(orphans, 'MCP tools that map to nothing (add to OP_TO_TOOL or MCP_NATIVE)').toEqual([]);
  });

  it('INV-3: every registered tool has a declared capability tier', () => {
    // declaredToolNames() throws inside the registrar if any tool is untiered.
    expect(() => declaredToolNames()).not.toThrow();
  });

  it('MCP_UNEXPOSED and OP_TO_TOOL are disjoint and reference real ops', async () => {
    const doc = await loadSpec();
    const real = new Set(specOperationManifest(doc));
    for (const op of OP_TO_TOOL.keys()) expect(real.has(op), `${op} not in openapi.yaml`).toBe(true);
    for (const op of MCP_UNEXPOSED.keys()) expect(real.has(op), `${op} not in openapi.yaml`).toBe(true);
    for (const op of OP_TO_TOOL.keys()) expect(MCP_UNEXPOSED.has(op)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails, and read the uncovered list**

Run: `pnpm test:integration -- src/mcp/contract.integration.test.ts`
Expected: INV-1 FAILS, printing every REST op with no tool and no exemption.

- [ ] **Step 3: Triage every uncovered op into `contract-map.ts`**

For each op the failure prints, add exactly one of:
- an `OP_TO_TOOL` entry (a tool already performs it), or
- an `MCP_UNEXPOSED` entry with a reason — `"pending — wave N"` for a write op a later wave will add, or a permanent reason (`"binary download — use generate_docx"`, `"async job polling — internal"` **or** promote to a tool per decision B) for non-actions, or
- extend `EXEMPT` only for true non-actions (health/docs/asset/contract/mcp plumbing).
Also resolve any INV-2 orphans by moving the tool into `OP_TO_TOOL` or `MCP_NATIVE`.

Repeat until all four tests pass. This is the burn-down baseline.

- [ ] **Step 4: Verify green**

Run: `pnpm test:integration -- src/mcp/contract.integration.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm lint
git add src/mcp/contract.integration.test.ts src/mcp/contract-map.ts
git commit -m "feat(mcp): contract test enforcing REST<->MCP parity (INV-1/2/3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: First write tool — `create_project` (canonical template) + INV-4

**Files:**
- Create: `src/mcp/create-project-handler.ts`, `src/mcp/create-project.integration.test.ts`
- Modify: `src/mcp/tools.ts` (register it — already tiered `write` in Task 1), `src/mcp/contract-map.ts` (already mapped in Task 5 seed), `src/mcp/handlers.ts` is NOT touched (own handler file, keeps files small).

**Interfaces:**
- Consumes: `createProject`, `pool`, `InvalidSourceLibraryError` (`../db/index.js`); `CreateProjectBodySchema` (`../ast/index.js`); `toolError` (`./handlers.js`).
- Produces: `handleCreateProject(args)` returning `ToolResult`; the tool `create_project` (tier `write`).

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/mcp/create-project.integration.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleCreateProject } from './create-project-handler.js';
import { CreateProjectBodySchema } from '../ast/index.js';
import { loadSpec } from '../test-utils/contract/validate-response.js';

const created: string[] = [];
afterAll(async () => {
  for (const id of created) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
});

async function seedLibraryId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE tier IN ('company','client') LIMIT 1`
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no company/client library seeded — run pnpm seed');
  return id;
}

describe('create_project MCP tool', () => {
  it('creates a project and returns its id', async () => {
    const libId = await seedLibraryId();
    const res = await handleCreateProject({
      name: `mcp-contract-${Date.now()}`,
      sourceLibraryIds: [libId],
    });
    expect(res.isError).not.toBe(true);
    const data = JSON.parse(res.content[0]!.text) as { id: string };
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    created.push(data.id);
  });

  it('returns a tool error (never throws) on invalid input', async () => {
    const res = await handleCreateProject({ name: '', sourceLibraryIds: [] });
    expect(res.isError).toBe(true);
  });

  it('INV-4: the tool input schema covers the OpenAPI required request fields', async () => {
    const doc = await loadSpec();
    const op = doc.paths['/projects']?.['post'] as {
      requestBody?: { content: { 'application/json': { schema: { required?: string[] } } } };
    };
    const required = op.requestBody?.content['application/json'].schema.required ?? [];
    const toolKeys = Object.keys(CreateProjectBodySchema.shape);
    for (const field of required) expect(toolKeys).toContain(field);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:integration -- src/mcp/create-project.integration.test.ts`
Expected: FAIL — `Cannot find module './create-project-handler.js'`.

- [ ] **Step 3: Write the handler**

```typescript
// src/mcp/create-project-handler.ts
import { createProject, pool, InvalidSourceLibraryError } from '../db/index.js';
import { CreateProjectBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError } from './handlers.js';

type ToolResult =
  | { readonly isError: true; readonly content: { readonly type: 'text'; readonly text: string }[] }
  | { readonly content: { readonly type: 'text'; readonly text: string }[] };

export async function handleCreateProject(args: unknown): Promise<ToolResult> {
  const parsed = CreateProjectBodySchema.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid create_project input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  try {
    const project = await createProject(parsed.data, pool);
    return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
  } catch (err) {
    if (err instanceof InvalidSourceLibraryError) return toolError(err.message);
    logger.error({ err }, 'mcp tool create_project failed');
    return toolError('Internal error — project creation failed');
  }
}
```

- [ ] **Step 4: Register the tool**

In `src/mcp/tools.ts`, add to `registerProjectTools(reg)`:

```typescript
  reg.register(
    'create_project',
    {
      description:
        'Create a project. Requires a name and an ordered, non-empty sourceLibraryIds list ' +
        '(company- or client-tier library UUIDs; priority = array order). Returns the new project. ' +
        'Discover library UUIDs with list_projects/search context first.',
      inputSchema: CreateProjectBodySchema.shape,
    },
    (args) => handleCreateProject(args)
  );
```

Import `handleCreateProject` from `./create-project-handler.js` and `CreateProjectBodySchema` from `../ast/index.js` at the top of `tools.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:integration -- src/mcp/create-project.integration.test.ts && pnpm test:integration -- src/mcp/contract.integration.test.ts`
Expected: create_project tests PASS; contract test still PASS (`post /projects` moved from `MCP_UNEXPOSED`→`OP_TO_TOOL` in the Task 5 seed — confirm it is not double-listed).

- [ ] **Step 6: Lint + commit**

```bash
pnpm lint
git add src/mcp/create-project-handler.ts src/mcp/create-project.integration.test.ts src/mcp/tools.ts
git commit -m "feat(mcp): create_project write tool (canonical template) + INV-4 schema check

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: ADRs, CLAUDE.md, CI

**Files:**
- Create: `docs/adr/044-mcp-contract-testing.md`, `docs/adr/045-mcp-capability-tiers.md`
- Modify: `CLAUDE.md`; CI workflow (only if the MCP contract test isn't already picked up by the integration run).

- [ ] **Step 1: ADR-044** — "MCP contract — hand-authored tool parity, verified by tests." Status/Context/Decision/Consequences. Context: MCP surface can drift from REST like `openapi.yaml` could (ADR-026). Decision: hand-author tools + `contract-map.ts` + INV-1/2/3(/4), reject generation for the same reason ADR-026 did. Consequences: new REST ops must map to a tool or `MCP_UNEXPOSED`; the allowlist burns down per wave.

- [ ] **Step 2: ADR-045** — "MCP capability tiers & permission scoping." Decision: `read`/`write`/`destructive` per tool (`capabilities.ts`), server-side gating via `MCP_ALLOWED_TIERS` (default `read,write`), mapped to MCP `readOnlyHint`/`destructiveHint`. Token-scoped tiers deferred to #43 (auth). Note the deferred elicitation alternative.

- [ ] **Step 3: CLAUDE.md** — beside the existing `openapi.yaml` contract bullet, add:

```markdown
- **The MCP tool surface is contract-bound to the API (ADR-044).** Every user-facing OpenAPI
  operation maps to an MCP tool or an explicit `MCP_UNEXPOSED` entry, CI-enforced by
  `src/mcp/contract.integration.test.ts`. Adding a REST route without a tool (or exemption) goes
  red. Each tool declares a `read`/`write`/`destructive` tier (`src/mcp/capabilities.ts`);
  `MCP_ALLOWED_TIERS` (default `read,write`) gates which are exposed — destructive/admin actions
  are off by default (ADR-045).
```

- [ ] **Step 4: Confirm CI runs the new test**

The CI sequence is `pnpm migrate → seed → test → test:integration`. The new `*.integration.test.ts` files are picked up by `test:integration` automatically. Verify:

Run: `pnpm test:integration -- src/mcp/`
Expected: all MCP integration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/044-mcp-contract-testing.md docs/adr/045-mcp-capability-tiers.md CLAUDE.md
git commit -m "docs(mcp): ADR-044 MCP contract + ADR-045 capability tiers; CLAUDE.md note

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Open the draft PR**

```bash
git push -u origin feat/mcp-contract
gh pr create --draft --title "feat(mcp): MCP contract — REST↔MCP parity gate + capability tiers" \
  --body "$(cat <<'EOF'
## Why
The MCP tool surface could silently drift from the REST API (unlike openapi.yaml, which ADR-026
locks down). This gives MCP the same guarantee and adds a read/write/destructive permission model
so an agent can't delete projects/clients by default.

## What
- Contract test (`src/mcp/contract.integration.test.ts`) enforcing REST↔MCP parity (INV-1/2/3).
- `contract-map.ts`: OP_TO_TOOL / MCP_UNEXPOSED (burn-down) / MCP_NATIVE.
- Capability tiers + tier-gating registrar; `MCP_ALLOWED_TIERS` (default read,write).
- First write tool `create_project` (canonical template) + INV-4 schema check.
- ADR-044, ADR-045.

## Testing
- [ ] Unit tests pass (`pnpm test`)
- [ ] Integration tests pass (`pnpm test:integration`)
- [ ] Lint + build clean (`pnpm lint`)
- [ ] CI green

🤖 Co-authored by Claude Opus 4.8. Refs #44, #43.
EOF
)"
```

(Push/PR only when the author OKs — per repo workflow, agent PRs are drafts.)

---

## Roadmap: write-tool waves (each its own plan at pickup)

The foundation above ships a green gate over today's tools plus one write tool. The remaining
user-facing mutations land in ≤500-LOC waves. **Each wave is expanded into its own plan when
picked up** (don't pre-write ~25 tools' code — it would drift). Every wave follows the Task 7 recipe:
new `*-handler.ts` → `reg.register` with a hand-tuned description + reused Zod schema → add tier to
`TOOL_TIERS` → move its ops from `MCP_UNEXPOSED` to `OP_TO_TOOL` → integration test → contract test
stays green. Deletes/withdraws get tier `destructive` (gated off by default).

| Wave | Domain | Tools (tier) | Ops burned down |
|------|--------|--------------|-----------------|
| 2 | Projects/packages | `rename_project`(write), `delete_project`(destructive), `restore_project`(write), `create_package`(write), `assign_specs_to_package`(write) | `patch/delete/restore /projects/{}`, package routes |
| 3 (#44) | Paragraphs | `add_paragraph`(write), `update_paragraph`(write), `remove_paragraph`(write) | `post/patch /specs/{}/paragraphs…`, `…/removal` |
| 4 | Spec lifecycle | `finalize_spec`, `reopen_spec`(write), `restore_spec`(write), `delete_spec`(destructive) | `post /specs/{}/finalize` (+ reopen, restore), `delete /specs/{}` |
| 5 | Merge | `apply_merge`(write) | `post /specs/{}/merge` |
| 6 | Assignment | `assign_numbering_profile`, `assign_style_source`(write), `lock_spec`/`unlock_spec`(write) | numbering-profile, style-source, lock routes |
| 7 | Config CRUD | templates, conventions, required-sections, revision-nomenclature (write; deletes destructive) | remaining CRUD ops |

When every wave lands, `MCP_UNEXPOSED` holds only permanent, reasoned exemptions — full parity, CI-locked.

---

## Self-Review

**Spec coverage:** design §3.1 (parity contract) → Tasks 5,6; §3.2 (tiers + gating) → Tasks 1,2,3,4; §3.3 (write build-out) → Task 7 + Roadmap; §6 (invariants as tests) → INV-1/2/3 (Task 6), INV-4 (Task 7), gating test (Task 4); §7 (ADRs, CLAUDE.md, CI) → Task 8. Decision E (ship gating now, token-scopes with #43) → env default + AUTH HOOK left in place. All covered.

**Placeholder scan:** the "triage" steps (Task 5 note, Task 6 Step 3) are executable procedures driven by the failing test's printed output, not TODOs — the alternative (hand-enumerating all 64 ops in the plan) would drift from `openapi.yaml`. All code steps contain complete code.

**Type consistency:** `ToolRegistrar`/`createRegistrar`/`register` (Tasks 3,4); `TOOL_TIERS`/`tierAnnotations`/`parseAllowedTiers`/`TOOL_TIER_VALUES`/`ToolTier` (Task 1, consumed 2,3,4); `OP_TO_TOOL`/`MCP_UNEXPOSED`/`MCP_NATIVE` (Task 5, consumed 6); `handleCreateProject` + `CreateProjectBodySchema.shape` (Task 7). Names consistent across tasks.

**Known verification points for the implementer:** (a) the SDK generic wiring of `register`/`ToolCallback` in Task 3 — fixed by `tsc`; (b) the exact `tools/list` helper in Task 4 Step 5 depends on the existing `server.integration.test.ts` shape — fall back to the in-process assertion if none exists; (c) the seeded `MCP_NATIVE` buckets in Task 5 are confirmed by the Task 6 triage.
