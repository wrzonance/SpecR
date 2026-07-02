# Chat-driven Focus Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the demo chat agent answers a locate-style question, highlight the relevant section(s) in the currently-active Project Spec Map / Report tab.

**Architecture:** Four locate-oriented MCP tools attach navigation anchors to their result's `_meta['specr/anchors']` (additive, text content unchanged). The demo chat bridge (`server.mjs`) forwards the answering tool's anchors to the browser as `focus.anchors`; the front-end `applyFocus` pulses them in the active view (map sheets via `is-flash`, report via `audit.showSection`) with a toast fallback.

**Tech Stack:** TypeScript/Node 22 ESM, `@modelcontextprotocol/sdk`, Zod v4, vitest (unit + integration), PostgreSQL 16; demo is vanilla ES-module JS (`server.mjs` + `js/*.js`), verified with Playwright.

**Spec:** `docs/superpowers/specs/2026-07-01-chat-driven-focus-design.md`

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` (error) in `src/`, `@typescript-eslint/no-explicit-any` (error). Test files relax line/console caps.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`. No `any`, no `as unknown as`, no `!` outside tests. Type-only imports use `import type`; relative imports use `.js`.
- Module boundaries: `src/mcp` imports DB types/functions only from `../db/index.js` (barrel), never a query file directly.
- MCP tools never throw — return `{ isError: true, content }` on failure.
- `openapi.yaml` is authoritative and CI-enforced; any route/response change updates it in the same PR.
- Integration tests truncate tables — run against an **isolated Postgres on 5434**, NEVER the demo DB on 5432.
- Commit scope = the module changed (e.g. `feat(mcp): ...`). GitHub PRs by Claude are **drafts**. Never commit to `main`. Credit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Backend + MCP changes land on `feat/mcp-focus-anchors` (from `origin/main`), draft PR to `main`, then cherry-picked to `feat/webgui-landed-features`. Demo-only files (`examples/web_ui_demo/**`) commit directly on `feat/webgui-landed-features`.

## File Structure

**Backend (branch `feat/mcp-focus-anchors`):**
- Create `src/mcp/anchors.ts` — pure anchor-derivation module (`McpAnchor`, per-tool helpers, `anchorsMeta`). One responsibility: project tool results → navigation anchors.
- Create `src/mcp/anchors.test.ts` — unit tests (no DB).
- Modify `src/mcp/handlers.ts` — attach `_meta` in `handleSearchLibrary`, `handleGetSpec`, `handleGetReferences`; extend local `ToolOk`.
- Modify `src/mcp/coordination-handler.ts` — attach `_meta` in `handleCoordinationReport`; extend local `ToolOk`.
- Modify `src/mcp/handlers.integration.test.ts` (or create if absent) — one wiring assertion.
- Modify `ARCHITECTURE.md` — document the `_meta['specr/anchors']` contract in the MCP section.

**Demo (branch `feat/webgui-landed-features`):**
- Modify `examples/web_ui_demo/server.mjs` — `execToolCall`/`runChat`/`handleChat` forward `focus.anchors`.
- Modify `examples/web_ui_demo/js/app.js` — extract `sheetForSection`/`flashSheet`, add `applyFocus`, wire `initChat({ onFocus: applyFocus })`.
- Modify `examples/web_ui_demo/js/chat.js` — `initChat(opts)` accepts `onFocus`, calls it with `focus.anchors`.

No CSS changes — reuses `.is-flash` (map sheet) and `.is-audit-pulse`/`.is-audit-target` (report).

---

## Task 0: Worktree + isolated Postgres setup

**Files:** none (environment).

- [ ] **Step 1: Create the backend worktree from origin/main**

```bash
cd /home/adam/github/SpecR
git fetch origin
git worktree add .worktrees/mcp-focus-anchors -b feat/mcp-focus-anchors origin/main
cd .worktrees/mcp-focus-anchors
pnpm install
```

- [ ] **Step 2: Start an isolated Postgres on 5434 (never touch 5432)**

```bash
docker run -d --name specr-focus-pg -e POSTGRES_USER=specr -e POSTGRES_PASSWORD=specr \
  -e POSTGRES_DB=specr -p 5434:5432 postgres:16
# wait for readiness, then migrate + seed against 5434:
export DATABASE_URL=postgres://specr:specr@localhost:5434/specr NODE_ENV=test
until docker exec specr-focus-pg pg_isready -U specr >/dev/null 2>&1; do sleep 1; done
pnpm migrate && pnpm seed
```

Expected: migrations apply, `spec_sections` seeded. Leave this container running for the integration test in Task 2.

---

## Task 1: `src/mcp/anchors.ts` — pure anchor derivation (TDD)

**Files:**
- Create: `src/mcp/anchors.ts`
- Test: `src/mcp/anchors.test.ts`

**Interfaces:**
- Produces:
  - `interface McpAnchor { readonly section: string; readonly specId?: string; readonly paragraphId?: string }`
  - `const ANCHORS_META_KEY = 'specr/anchors'`
  - `anchorsFromSearch(results: readonly ParagraphSearchResult[]): McpAnchor[]`
  - `anchorsFromSpecTree(tree: { readonly id: string; readonly section: string }): McpAnchor[]`
  - `anchorsFromReferences(a: { section: string; outbound: readonly OutboundReference[]; inbound: readonly InboundReference[] }): McpAnchor[]`
  - `anchorsFromReport(findings: readonly Finding[]): McpAnchor[]`
  - `anchorsMeta(anchors: readonly McpAnchor[]): Record<string, unknown> | undefined`

- [ ] **Step 1: Write the failing unit test**

Create `src/mcp/anchors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  anchorsFromSearch,
  anchorsFromSpecTree,
  anchorsFromReferences,
  anchorsFromReport,
  anchorsMeta,
  ANCHORS_META_KEY,
} from './anchors.js';

describe('anchorsFromSearch', () => {
  it('maps each hit to {section, specId, paragraphId} and drops empty sections', () => {
    const anchors = anchorsFromSearch([
      { paragraphId: 'p1', text: 't', nodeType: 'pr1', specId: 's1', specSection: '07 84 00', specTitle: 'Firestopping' },
      { paragraphId: 'p2', text: 't', nodeType: 'pr1', specId: 's2', specSection: '', specTitle: '' },
    ]);
    expect(anchors).toEqual([{ section: '07 84 00', specId: 's1', paragraphId: 'p1' }]);
  });
});

describe('anchorsFromSpecTree', () => {
  it('yields one {section, specId} anchor', () => {
    expect(anchorsFromSpecTree({ id: 's1', section: '09 21 16' })).toEqual([
      { section: '09 21 16', specId: 's1' },
    ]);
  });
  it('yields nothing for a blank section', () => {
    expect(anchorsFromSpecTree({ id: 's1', section: '' })).toEqual([]);
  });
});

describe('anchorsFromReferences', () => {
  it('includes the queried section plus outbound/inbound anchors', () => {
    const anchors = anchorsFromReferences({
      section: '08 11 13',
      outbound: [
        { sourceSpecId: 's1', referenceText: 'x', targetSection: '07 84 00', targetSpecId: 't1', isResolved: true, isBroken: false },
        { sourceSpecId: 's1', referenceText: 'y', targetSection: null, targetSpecId: null, isResolved: false, isBroken: true },
      ],
      inbound: [
        { sourceSpecId: 's9', sourceSection: '09 21 16', sourceTitle: 'Gyp', sourceParagraphId: 'p9', referenceText: 'z', isResolved: true, isBroken: false },
      ],
    });
    expect(anchors).toEqual([
      { section: '08 11 13' },
      { section: '07 84 00', specId: 't1' },
      { section: '09 21 16', specId: 's9', paragraphId: 'p9' },
    ]);
  });
});

describe('anchorsFromReport', () => {
  // dangling_ref carries an exact sourceParagraphId (from BrokenRef); the other
  // reference-consistency findings (built from ClassifiedRef on origin/main) have
  // no per-paragraph locator, so they anchor at the source section only.
  it('locates dangling-ref findings at the source paragraph; other findings at their section', () => {
    const anchors = anchorsFromReport([
      { type: 'dangling_ref', refId: 'r1', sourceSpecId: 's1', sourceSpecSection: '08 11 13', sourceParagraphId: 'p1', snippet: 'see Section 07 84 00', targetSpecSection: '07 84 00', referenceText: 'Section 07 84 00', availableFrom: [] },
      { type: 'related_cited_not_listed', sourceSpecId: 's3', sourceSpecSection: '26 05 33', section: '26 05 33' },
      { type: 'present_not_required', section: '01 10 00', specId: 's2', title: 'Summary' },
      { type: 'required_not_present', section: '03 30 00', title: null, requiredId: 'r1' },
    ]);
    expect(anchors).toEqual([
      { section: '08 11 13', specId: 's1', paragraphId: 'p1' },
      { section: '26 05 33', specId: 's3' },
      { section: '01 10 00', specId: 's2' },
      { section: '03 30 00' },
    ]);
  });
});

describe('anchorsMeta', () => {
  it('wraps non-empty anchors under the namespaced key', () => {
    expect(anchorsMeta([{ section: '07 84 00' }])).toEqual({
      [ANCHORS_META_KEY]: [{ section: '07 84 00' }],
    });
  });
  it('is undefined for an empty list (so no _meta is attached)', () => {
    expect(anchorsMeta([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/mcp/anchors.test.ts`
Expected: FAIL — `Cannot find module './anchors.js'`.

- [ ] **Step 3: Implement `src/mcp/anchors.ts`**

```ts
// src/mcp/anchors.ts
// Navigation hints attached to MCP tool results so a UI client (the web_ui_demo
// chat sidebar) can highlight the section(s) an answer is about. Carried in the
// result's `_meta` under a SpecR-namespaced key — MCP's sanctioned channel for
// implementation metadata — so existing text-only consumers are unaffected.
// Pure: derives anchors from data the handlers already hold; no I/O.
import type {
  ParagraphSearchResult,
  InboundReference,
  OutboundReference,
  Finding,
} from '../db/index.js';

export const ANCHORS_META_KEY = 'specr/anchors';

export interface McpAnchor {
  readonly section: string;
  readonly specId?: string;
  readonly paragraphId?: string;
}

// Omit id fields that are absent — exactOptionalPropertyTypes forbids
// `{ specId: undefined }`. `null` (nullable columns) is treated as absent.
function anchor(section: string, specId?: string | null, paragraphId?: string | null): McpAnchor {
  return {
    section,
    ...(specId ? { specId } : {}),
    ...(paragraphId ? { paragraphId } : {}),
  };
}

export function anchorsFromSearch(results: readonly ParagraphSearchResult[]): McpAnchor[] {
  return results
    .filter((r) => r.specSection !== '')
    .map((r) => anchor(r.specSection, r.specId, r.paragraphId));
}

export function anchorsFromSpecTree(tree: { readonly id: string; readonly section: string }): McpAnchor[] {
  return tree.section ? [anchor(tree.section, tree.id)] : [];
}

export function anchorsFromReferences(a: {
  readonly section: string;
  readonly outbound: readonly OutboundReference[];
  readonly inbound: readonly InboundReference[];
}): McpAnchor[] {
  const out: McpAnchor[] = [anchor(a.section)];
  for (const o of a.outbound) {
    if (o.targetSection) out.push(anchor(o.targetSection, o.targetSpecId));
  }
  for (const i of a.inbound) {
    out.push(anchor(i.sourceSection, i.sourceSpecId, i.sourceParagraphId));
  }
  return out;
}

// A finding's anchor is where it should be *located* in the UI. `dangling_ref`
// (built from BrokenRef) carries an exact sourceParagraphId, so it anchors at the
// source paragraph (matching ADR-041). On origin/main the reference-consistency
// findings (related_*, standard_cited_not_listed) are built from ClassifiedRef,
// which has NO per-paragraph locator — they anchor at the source section only.
// (The coord-enrich branch #328 adds sourceParagraphId to those variants; Task 4
// reconciles the demo branch, where that field is present and required.)
// Submittal / implied / umbrella findings carry no single section locator → no anchor.
function findingAnchor(f: Finding): McpAnchor | null {
  switch (f.type) {
    case 'dangling_ref':
      return anchor(f.sourceSpecSection, f.sourceSpecId, f.sourceParagraphId);
    case 'related_listed_not_cited':
    case 'related_cited_not_listed':
    case 'standard_cited_not_listed':
      return anchor(f.sourceSpecSection, f.sourceSpecId);
    case 'present_not_required':
      return anchor(f.section, f.specId);
    case 'required_not_present':
      return anchor(f.section);
    default:
      return null;
  }
}

export function anchorsFromReport(findings: readonly Finding[]): McpAnchor[] {
  const out: McpAnchor[] = [];
  for (const f of findings) {
    const a = findingAnchor(f);
    if (a) out.push(a);
  }
  return out;
}

export function anchorsMeta(anchors: readonly McpAnchor[]): Record<string, unknown> | undefined {
  return anchors.length > 0 ? { [ANCHORS_META_KEY]: anchors } : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/mcp/anchors.test.ts`
Expected: PASS (all 8 assertions).

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: clean (ESLint + `tsc --noEmit` + prettier). If `tsc` flags a field-name mismatch in a helper, fix the helper to match the real type from `../db/index.js` (the test encodes the true shapes).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/anchors.ts src/mcp/anchors.test.ts
git commit -m "feat(mcp): pure anchor-derivation module for UI navigation hints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Attach `_meta` anchors in the four handlers (TDD wiring)

**Files:**
- Modify: `src/mcp/handlers.ts` (`handleSearchLibrary`, `handleGetSpec`, `handleGetReferences`; extend `ToolOk`)
- Modify: `src/mcp/coordination-handler.ts` (`handleCoordinationReport`; extend `ToolOk`)
- Test: `src/mcp/handlers.integration.test.ts`

**Interfaces:**
- Consumes: `anchorsFromSearch`, `anchorsFromSpecTree`, `anchorsFromReferences`, `anchorsFromReport`, `anchorsMeta`, `ANCHORS_META_KEY` from `./anchors.js` (Task 1).

- [ ] **Step 1: Write the failing integration test**

Create `src/mcp/handlers.integration.test.ts` (needs the isolated DB from Task 0). It builds its OWN fixture — `pnpm seed` only loads `spec_sections` reference data, never specs/paragraphs — so the search hit is deterministic regardless of ambient corpus. Mirrors the self-contained pattern in `src/db/queries/search.integration.test.ts` (`createSpec` + `insertTree`, both barrel-exported from `../db/index.js`; teardown deletes the spec):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, createSpec, insertTree } from '../db/index.js';
import { handleSearchLibrary } from './handlers.js';
import { ANCHORS_META_KEY, type McpAnchor } from './anchors.js';

// A token no other loaded paragraph contains, so the search hit is ours alone.
const UNIQUE = 'zzqquuxfocus';
const PARA_ID = '20000000-0000-0000-0000-0000000000f2';
let specId: string;

beforeAll(async () => {
  specId = await createSpec({ section: '27 15 00', title: 'Focus Anchor Test Spec', source: 'arcat' });
  await insertTree(
    {
      id: specId,
      section: '27 15 00',
      title: 'Focus Anchor Test Spec',
      parts: [
        {
          id: '20000000-0000-0000-0000-0000000000f1',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '20000000-0000-0000-0000-0000000000fa',
              type: 'article',
              text: 'SUMMARY',
              children: [
                { id: PARA_ID, type: 'pr1', text: `Requirement mentioning ${UNIQUE} cabling.`, children: [], meta: {} },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    },
    specId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
});

describe('handleSearchLibrary — _meta anchors (focus channel)', () => {
  it('attaches a navigation anchor for the matching hit under _meta', async () => {
    const result = await handleSearchLibrary({ query: UNIQUE, division: undefined, limit: 10 });
    expect('isError' in result).toBe(false);
    const anchors = (result as { _meta?: Record<string, unknown> })._meta?.[ANCHORS_META_KEY] as
      | McpAnchor[]
      | undefined;
    expect(anchors).toBeDefined();
    const mine = anchors!.find((a) => a.specId === specId);
    expect(mine).toEqual({ section: '27 15 00', specId, paragraphId: PARA_ID });
    // Regression guard: the text content is still the full JSON payload.
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('paragraphId');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5434/specr NODE_ENV=test pnpm test:integration -- src/mcp/handlers.integration.test.ts`
Expected: FAIL — `_meta` is `undefined` (anchors not attached yet).

- [ ] **Step 3: Extend `ToolOk` and attach `_meta` in `src/mcp/handlers.ts`**

Change the `ToolOk` type (near the top, ~line 37) to carry optional metadata:

```ts
type ToolOk = {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly _meta?: Record<string, unknown>;
};
```

Add the import near the other local imports (top of file):

```ts
import { anchorsFromSearch, anchorsFromSpecTree, anchorsFromReferences, anchorsMeta } from './anchors.js';
```

In `handleSearchLibrary`, replace the success `return`:

```ts
    const results = await searchParagraphs(query, division, limit);
    const meta = anchorsMeta(anchorsFromSearch(results));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      ...(meta ? { _meta: meta } : {}),
    };
```

In `handleGetSpec`, replace the success `return` (the block that builds `text` from `{ ...result, styleSource, onboardingStatus }`):

```ts
    const text = JSON.stringify({ ...result, styleSource, onboardingStatus }, null, 2);
    const meta = anchorsMeta(anchorsFromSpecTree(result.tree));
    return { content: [{ type: 'text' as const, text }], ...(meta ? { _meta: meta } : {}) };
```

In `referencesResponse` (the helper that builds the get_references `ToolResult`), attach anchors:

```ts
function referencesResponse(
  projectId: string,
  section: string,
  outbound: readonly OutboundReference[],
  inbound: readonly InboundReference[]
): ToolResult {
  const meta = anchorsMeta(anchorsFromReferences({ section, outbound, inbound }));
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ projectId, section, outbound, inbound }, null, 2),
      },
    ],
    ...(meta ? { _meta: meta } : {}),
  };
}
```

- [ ] **Step 4: Extend `ToolOk` and attach `_meta` in `src/mcp/coordination-handler.ts`**

Change its local `ToolOk` (line ~4):

```ts
type ToolOk = {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly _meta?: Record<string, unknown>;
};
```

Add the import and attach anchors to the success return (the line building `text` from `report`):

```ts
import { anchorsFromReport, anchorsMeta } from './anchors.js';
// ...
    const meta = anchorsMeta(anchorsFromReport(report.findings));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      ...(meta ? { _meta: meta } : {}),
    };
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5434/specr NODE_ENV=test pnpm test:integration -- src/mcp/handlers.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Full lint**

Run: `pnpm lint`
Expected: clean. (`_meta` is now part of each `ToolOk`; the spread-conditional keeps `exactOptionalPropertyTypes` happy.)

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/coordination-handler.ts src/mcp/handlers.integration.test.ts
git commit -m "feat(mcp): attach navigation anchors to 4 locate tools via _meta

search_library, get_spec, get_references, coordination_report now carry
_meta['specr/anchors'] for UI clients. Text content unchanged; additive.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Document the contract + verify openapi + full green

**Files:**
- Modify: `ARCHITECTURE.md` (MCP section)
- Verify: `openapi.yaml` (expected: no change)

- [ ] **Step 1: Confirm openapi does not schema per-tool MCP output**

Run: `rg -n "/mcp" openapi.yaml`
Then inspect the `POST /mcp` response schema. Expected: a generic JSON-RPC passthrough (e.g. `type: object` / `additionalProperties: true`) that does not enumerate tool result fields → **no openapi change**. If (unexpectedly) it constrains tool results, add an optional `_meta` object to that schema and note it here.

- [ ] **Step 2: Document the `_meta` anchor contract in `ARCHITECTURE.md`**

Under the MCP Server section, add:

```markdown
#### Result anchors (`_meta['specr/anchors']`)

Locate-oriented tools (`search_library`, `get_spec`, `get_references`,
`coordination_report`) attach navigation anchors to their result's `_meta` under
the key `specr/anchors`: an array of `{ section: string; specId?: string;
paragraphId?: string }`. Anchors are a projection of data already in the result
(`src/mcp/anchors.ts`, pure) — the text `content` is unchanged, so text-only
consumers are unaffected. UI clients (the `web_ui_demo` chat sidebar) use them to
highlight the section(s) an answer is about in the active view.
```

- [ ] **Step 3: Run the full suite against the isolated DB**

Run:
```bash
export DATABASE_URL=postgres://specr:specr@localhost:5434/specr NODE_ENV=test
pnpm lint && pnpm test && pnpm test:integration
```
Expected: unit green (incl. `anchors.test.ts`), integration green (incl. the openapi contract gate `src/api/contract.integration.test.ts`, unchanged, and the new handler test).

- [ ] **Step 4: Commit (docs only) if ARCHITECTURE.md changed**

```bash
git add ARCHITECTURE.md
git commit -m "docs(mcp): document the _meta['specr/anchors'] result contract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push branch + open a draft PR to main**

```bash
git push -u origin feat/mcp-focus-anchors
gh pr create --draft --base main \
  --title "feat(mcp): navigation anchors on locate tools via _meta" \
  --body "$(cat <<'EOF'
## Why
The web_ui_demo chat can answer *"which spec references firestopping"* but the
answer is text only. The section/spec/paragraph identifiers needed to jump there
already exist in the tool results — they were just never surfaced to a UI client.

## What
Four locate-oriented MCP tools (`search_library`, `get_spec`, `get_references`,
`coordination_report`) attach navigation anchors to their result's
`_meta['specr/anchors']` (`{section, specId?, paragraphId?}`). Additive — the
text `content` is byte-for-byte unchanged, so existing consumers are unaffected.
Derivation is a pure module (`src/mcp/anchors.ts`). No DB/REST/openapi change.

Backend half of a demo feature (spec:
`docs/superpowers/specs/2026-07-01-chat-driven-focus-design.md`); cherry-picked
onto `feat/webgui-landed-features` where the bridge + front-end consume it.

## Testing
- [x] Unit: `src/mcp/anchors.test.ts` (pure derivations)
- [x] Integration: `handleSearchLibrary` result carries `_meta` anchors (isolated PG); text content unchanged
- [x] Lint (ESLint + tsc + prettier) clean
- [x] openapi contract gate green (unchanged)
- [ ] CI green

🤖 Co-authored by Claude Opus 4.8. Part of the web_ui_demo focus channel.
EOF
)"
```

---

## Task 4: Cherry-pick the backend commits onto the demo branch

**Files:** none new (git).

- [ ] **Step 1: From the main worktree, cherry-pick the backend commits**

```bash
cd /home/adam/github/SpecR   # main worktree, on feat/webgui-landed-features
git branch --show-current    # must print feat/webgui-landed-features
git fetch origin
git log --oneline feat/mcp-focus-anchors -4   # note the anchor + handler (+ docs) SHAs, oldest first
git cherry-pick <anchors-sha> <handlers-sha> [<docs-sha>]
```

Expected: clean cherry-pick (backend files are disjoint from the demo front-end). If a conflict appears, it will be in `ARCHITECTURE.md` only — resolve by keeping both sections.

- [ ] **Step 2: Reconcile `anchors.test.ts` with the demo branch's `Finding` type**

The demo branch carries coord-enrich (#328), where the reference-consistency
findings (`related_*`, `standard_cited_not_listed`) have a **required**
`sourceParagraphId` — absent on `origin/main`. So the cherry-picked
`anchors.test.ts` `related_cited_not_listed` literal (which omits it) fails `tsc`
on this branch. `anchors.ts` is unchanged (its `findingAnchor` reads
`sourceSpecSection`/`sourceSpecId`, present on both branches → section-level
anchor). Add the required field to the literal only; the expected anchor is
unchanged (still section-level in v1):

```ts
      { type: 'related_cited_not_listed', sourceSpecId: 's3', sourceSpecSection: '26 05 33', sourceParagraphId: 'p3', section: '26 05 33' },
```
(expected `anchors` array unchanged — `{ section: '26 05 33', specId: 's3' }`).

This one-field divergence resolves when #328 lands on `main` and this branch
rebases. A follow-up may then enrich reference anchors to paragraph-precise.

- [ ] **Step 3: Verify the demo branch builds green**

```bash
pnpm lint && pnpm test -- src/mcp/anchors.test.ts
git add src/mcp/anchors.test.ts
git commit -m "test(mcp): satisfy demo-branch Finding.sourceParagraphId in anchor test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: lint clean, `anchorsFromReport` test green.

---

## Task 5: Demo bridge — forward anchors (`server.mjs`)

**Files:**
- Modify: `examples/web_ui_demo/server.mjs` (`execToolCall`, `runChat`, `handleChat`)

**Interfaces:**
- Consumes: MCP `tools/call` result `_meta['specr/anchors']` (Task 2, cherry-picked in Task 4).
- Produces: `/chat` response `data.focus = { anchors: Array<{section, specId?, paragraphId?}> }`.

- [ ] **Step 1: `execToolCall` returns the result's anchors**

Replace the body of `execToolCall` (the success path that builds `text`):

```js
  try {
    const result = await mcpRpc('tools/call', { name: call.function?.name, arguments: args });
    const text =
      (result?.content || [])
        .map((part) => part.text)
        .filter(Boolean)
        .join('\n') || '(no content)';
    const raw = result?._meta?.['specr/anchors'];
    const anchors = Array.isArray(raw) ? raw : [];
    return { text: text.slice(0, 8000), ok: result?.isError !== true, anchors };
  } catch (err) {
    return { text: `tool error: ${err.message}`, ok: false, anchors: [] };
  }
```

- [ ] **Step 2: Add a `dedupeAnchors` helper (module scope, near `sanitizeMessages`)**

```js
// Collapse duplicate navigation anchors (a search may return the same section
// many times) and cap the payload so a broad answer can't flood the UI.
function dedupeAnchors(anchors) {
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    if (!a || typeof a.section !== 'string' || a.section === '') continue;
    const key = `${a.section}|${a.specId ?? ''}|${a.paragraphId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= 50) break;
  }
  return out;
}
```

- [ ] **Step 3: `runChat` keeps the last successful enriched call's anchors and returns `focus`**

In `runChat`, initialize `let focusAnchors = [];` next to `const toolCalls = [];`, capture anchors in the tool loop, and include `focus` in both return points:

```js
  const toolCalls = [];
  let focusAnchors = [];
  for (let round = 0; round < CHAT_MAX_TOOL_ROUNDS; round++) {
    const completion = await callOpenAI(messages, tools);
    const message = completion.choices?.[0]?.message;
    if (!message) throw new Error('OpenAI returned no message');
    messages.push(message);
    const calls = message.tool_calls;
    if (!calls || calls.length === 0) {
      return { reply: message.content || '', toolCalls, focus: { anchors: dedupeAnchors(focusAnchors) } };
    }
    for (const call of calls) {
      const { text, ok, anchors } = await execToolCall(call);
      toolCalls.push({ name: call.function?.name, ok });
      if (ok && anchors.length > 0) focusAnchors = anchors; // last enriched answer wins
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }
  const finalMessage = (await callOpenAI(messages, undefined)).choices?.[0]?.message;
  return {
    reply: finalMessage?.content || 'Reached the tool-call limit.',
    toolCalls,
    focus: { anchors: dedupeAnchors(focusAnchors) },
  };
```

- [ ] **Step 4: `handleChat` passes `focus` to the client**

Replace the success send:

```js
    const { reply, toolCalls, focus } = await runChat(clean);
    sendJson(res, 200, { success: true, data: { reply, toolCalls, focus, model: OPENAI_MODEL } });
```

- [ ] **Step 5: Smoke-check the server starts and `/chat` shape is intact**

Run: `node --check examples/web_ui_demo/server.mjs`
Expected: no syntax error. (Full behavior is verified end-to-end in Task 8.)

- [ ] **Step 6: Commit**

```bash
git add examples/web_ui_demo/server.mjs
git commit -m "feat(examples): chat bridge forwards MCP anchors as focus payload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `applyFocus` + navigate refactor (`app.js`)

**Files:**
- Modify: `examples/web_ui_demo/js/app.js` (extract `sheetForSection`/`flashSheet` from `navigateToSection`; add `applyFocus`; wire `initChat`)

**Interfaces:**
- Consumes: module-scoped `currentView`, `audit` (`audit.showSection`), `loadedSections()`, `toast`, `showView`.
- Produces: `applyFocus(anchors)` passed to `initChat({ onFocus: applyFocus })`.

- [ ] **Step 1: Refactor `navigateToSection` to share `sheetForSection` + `flashSheet`**

Replace the existing `navigateToSection` (≈ lines 1856-1874) with:

```js
function sheetForSection(section) {
  const specIds = loadedSections().get(section);
  if (!specIds || specIds.length === 0) return null;
  // Same-section duplicates sit adjacent on the section-sorted board; pick the
  // first sheet in DOM order so navigation is deterministic.
  return specIds.map((id) => document.getElementById(`sheet-${id}`)).find((node) => node !== null) ?? null;
}

function flashSheet(sheet, { scroll }) {
  if (scroll) sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sheet.classList.remove('is-flash');
  void sheet.offsetWidth; // restart the flash animation so flashes never pile up
  sheet.classList.add('is-flash');
  sheet.addEventListener('animationend', () => sheet.classList.remove('is-flash'), { once: true });
}

function navigateToSection(section) {
  const sheet = sheetForSection(section);
  if (!sheet) return;
  if (currentView !== 'map') showView('map');
  flashSheet(sheet, { scroll: true });
}
```

- [ ] **Step 2: Add `applyFocus` (place it right after `navigateToSection`)**

```js
// Chat-driven focus: highlight the section(s) an answer resolves to in the
// currently-active tab. Never switches views — a toast is the fallback when the
// active tab can't show them (spec: 2026-07-01-chat-driven-focus).
function focusToast(count) {
  const s = count === 1 ? '' : 's';
  toast(`${count} section${s} found — open Project Spec Map to view`, 'info');
}

function applyFocusOnMap(sections) {
  const sheets = sections.map(sheetForSection).filter((node) => node !== null);
  if (sheets.length === 0) {
    const s = sections.length === 1 ? '' : 's';
    toast(`${sections.length} section${s} found — none are loaded in this project map`, 'info');
    return;
  }
  sheets.forEach((sheet, i) => flashSheet(sheet, { scroll: i === 0 }));
}

function applyFocusOnReport(sections) {
  void audit.showSection(sections[0]);
  if (sections.length > 1) {
    toast(`${sections.length} sections found — showing the first; open Project Spec Map to see all`, 'info');
  }
}

function applyFocus(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return;
  const sections = [...new Set(anchors.map((a) => a && a.section).filter(Boolean))];
  if (sections.length === 0) return;
  if (currentView === 'map') return applyFocusOnMap(sections);
  if (currentView === 'report' && audit) return applyFocusOnReport(sections);
  focusToast(sections.length);
}
```

- [ ] **Step 3: Wire `applyFocus` into the chat init (≈ line 2036)**

Change:

```js
  initChat();
```

to:

```js
  initChat({ onFocus: applyFocus });
```

- [ ] **Step 4: Lint the demo scripts**

Run: `pnpm exec prettier --check examples/web_ui_demo/js/app.js`
Expected: pass (or run `pnpm exec prettier --write` on it). The demo JS is outside the `src/` ESLint program; prettier is the formatter gate. Then `node --check examples/web_ui_demo/js/app.js` → no syntax error.

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/js/app.js
git commit -m "feat(examples): applyFocus highlights answer sections in the active tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `chat.js` invokes `onFocus`

**Files:**
- Modify: `examples/web_ui_demo/js/chat.js` (`initChat(opts)`; call `onFocus` with `focus.anchors`)

**Interfaces:**
- Consumes: `body.data.focus.anchors` from `/chat` (Task 5); `opts.onFocus` from `app.js` (Task 6).

- [ ] **Step 1: Accept `opts.onFocus`**

Change the signature and capture the callback at the top of `initChat`:

```js
export function initChat(opts = {}) {
  const onFocus = typeof opts.onFocus === 'function' ? opts.onFocus : null;
```

- [ ] **Step 2: Fire `onFocus` after rendering the reply**

In `send`, right after `addToolTrace(bubble, body.data.toolCalls);`:

```js
      addToolTrace(bubble, body.data.toolCalls);
      const anchors = body.data.focus?.anchors;
      if (onFocus && Array.isArray(anchors) && anchors.length > 0) onFocus(anchors);
```

- [ ] **Step 3: Format + syntax check**

Run: `pnpm exec prettier --check examples/web_ui_demo/js/chat.js && node --check examples/web_ui_demo/js/chat.js`
Expected: pass, no syntax error.

- [ ] **Step 4: Commit**

```bash
git add examples/web_ui_demo/js/chat.js
git commit -m "feat(examples): chat sidebar drives applyFocus with answer anchors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: End-to-end verification (Playwright)

**Files:** none (verification only).

- [ ] **Step 1: Restart the demo against the demo DB (5432)**

Ensure the SpecR API + demo server are running (API on :3000, demo on 0.0.0.0:3001) against the demo DB, so the loaded project + 3 fixtures are present. (Do NOT point the demo at 5434.)

- [ ] **Step 2: Isolated `applyFocus` test — no OpenAI spend**

With the demo open in Playwright, on the **Project Spec Map** tab, inject a synthetic focus payload and assert a sheet flashes:

```js
// browser_evaluate
() => {
  const section = document.querySelector('.spec-sheet [data-section]')?.dataset.section;
  window.__demoApplyFocusProbe = section; // for the assertion
  return section;
}
```

Then verify: calling the real chat path is not required for structure — instead confirm `applyFocus` is reachable by simulating a `/chat` response shape is out of scope here; the deterministic check is: switch to **Project Settings**, then dispatch a focus with a known section and confirm the fallback **toast** appears (text contains "open Project Spec Map"). Use the section captured above.

- [ ] **Step 3: One real end-to-end run (optional, small OpenAI spend)**

On the **Project Spec Map** tab, open the chat and ask: *"which spec references firestopping?"* Confirm: the relevant sheet(s) flash and the first scrolls into view; the tool trace shows `search_library`/`get_references`; 0 console errors. Repeat on **Project Settings** → confirm the toast fallback fires instead.

- [ ] **Step 4: Push the demo branch**

```bash
git push origin feat/webgui-landed-features
```

PR #324 (already open, draft) picks up the new commits. Note in the PR that it depends on the `feat/mcp-focus-anchors` cherry-pick (Task 4) which will drop out on rebase once that backend PR merges.

---

## Teardown (after both PRs are settled)

```bash
docker rm -f specr-focus-pg
git worktree remove .worktrees/mcp-focus-anchors   # only after the backend PR merges
```

---

## Self-Review

**Spec coverage:**
- Layer A (4 tools + `_meta`) → Tasks 1–3. ✅
- `get_paragraph` excluded → stated in Task file structure + spec. ✅
- Layer B (bridge forwards anchors) → Task 5. ✅
- Layer C (`applyFocus`, map/report/toast, no view switch) → Tasks 6–7. ✅
- Multiple targets: highlight all, scroll first → Task 6 `applyFocusOnMap`. ✅
- Tab mismatch → toast → Task 6 `focusToast` / `applyFocusOnReport`. ✅
- Branch/cherry-pick workflow → Tasks 0, 3, 4, 8. ✅
- Isolated Postgres (5434), never demo DB → Task 0/2/3. ✅
- openapi verify → Task 3 Step 1. ✅
- Testing: unit (anchors) + one integration wiring + Playwright → Tasks 1, 2, 8. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows full code; every run step has an expected result. Task 8 Step 2 is a manual verification (the demo has no JS test runner) — described concretely.

**Type consistency:** `McpAnchor { section; specId?; paragraphId? }` used identically across `anchors.ts`, the bridge dedupe key, and `applyFocus`. Handler field names (`specSection`, `specId`, `paragraphId`, `targetSection`, `targetSpecId`, `sourceSection`, `sourceSpecId`, `sourceParagraphId`, `sourceSpecSection`) match the real types read from `src/db/queries/{search,refs,coordination}.ts`. `focus.anchors` is the single shape crossing bridge → `chat.js` → `applyFocus`.
