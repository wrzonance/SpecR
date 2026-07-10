# Reference-Graph Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the full section-reference graph (nodes, edges, umbrella annotations) for a whole project or library in one REST/MCP call, so consumers stop fanning out N per-spec calls and reassembling it client-side (issue #447).

**Architecture:** A pure read model over the existing `specs` / `paragraphs` / `spec_references` tables — no migration. A DB layer reads the in-scope specs and their section references inside a `READ ONLY REPEATABLE READ` snapshot (mirroring `getCoordinationReport`); a pure builder assembles `{ nodes, edges, umbrella }`. Edges resolve **scope-relative** (target section matched against the in-scope node set), which coincides with the stored project-scoped `target_spec_id` for projects and is the only correct resolution for library masters (whose stored `target_spec_id` is resolved globally at ingest). Umbrella annotations reuse the ADR-042 `buildUmbrellaCalloutFindings` machinery verbatim. Two thin REST routes and one MCP tool (`get_reference_graph`, read tier) expose it.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, `pg`, PostgreSQL, vitest. ESM (`.js` import extensions, `import type` for type-only).

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ **400**, `no-console` error, `@typescript-eslint/no-explicit-any` error. Tests relax line/function/console caps.
- TypeScript strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `verbatimModuleSyntax`. No `any`, no `as unknown as`, no cross-boundary assertions, no non-null `!` outside tests.
- Module boundaries: `src/db/queries/*` modules may import sibling query modules by relative path; API/MCP import DB functions from `../db/index.js` barrel only. MCP tools import DB functions from `../db/index.js` only.
- `openapi.yaml` is authoritative — any route change updates it in the SAME PR (CI contract gate `src/api/contract.integration.test.ts`).
- MCP surface is contract-bound (`src/mcp/contract-map.ts`, ADR-044); every REST op maps to a tool or `MCP_UNEXPOSED`; every tool has a tier (`src/mcp/capabilities.ts`, ADR-045).
- MCP tools NEVER throw — return `{ isError: true, content: [...] }`. Use `z.uuid()` (Zod v4).
- Commit scope = module changed, e.g. `feat(db): …`. Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `feat/issue-447` (already checked out). Never commit to main.
- Anchor cap constant: **50** paragraph anchors per edge.

---

## File Structure

- `src/db/queries/reference-graph.ts` (create) — types, pure `buildReferenceGraph`, DB `getReferenceGraph` + scope reads. One file; if it approaches 400 lines, extract the pure builder to `reference-graph-build.ts`.
- `src/db/queries/libraries.ts` (modify) — add `LibraryNotFoundError`.
- `src/db/index.ts` (modify) — barrel-export the new symbols.
- `src/db/queries/reference-graph.test.ts` (create) — unit tests for the pure builder.
- `src/db/queries/reference-graph.integration.test.ts` (create) — DB tests + agreement with `getOutboundReferences`.
- `src/api/reference-graph.ts` (create) — two Express handlers.
- `src/api/router.ts` (modify) — wire both routes.
- `src/api/reference-graph.integration.test.ts` (create) — route/response/openapi tests.
- `src/api/contract.integration.test.ts` (modify) — add both ops to `RESPONSE_ALLOWLIST`.
- `openapi.yaml` (modify) — two paths + `ReferenceGraph*` schemas.
- `src/mcp/reference-graph-handler.ts` (create) — `handleGetReferenceGraph`.
- `src/mcp/report-tools.ts` (modify) — register `get_reference_graph`.
- `src/mcp/contract-map.ts` (modify) — `OP_TO_TOOL` (both ops) + `INV5_READ_PENDING`.
- `src/mcp/capabilities.ts` (modify) — `TOOL_TIERS` read entry.
- `src/mcp/reference-graph.integration.test.ts` (create) — MCP handler tests.
- `docs/adr/063-reference-graph-scope-relative-resolution.md` (create) — records the scope-relative edge-resolution decision.

---

## Task 1: Pure graph builder + types

**Files:**
- Create: `src/db/queries/reference-graph.ts` (types + `buildReferenceGraph` only in this task)
- Test: `src/db/queries/reference-graph.test.ts`

**Interfaces:**
- Consumes: `buildUmbrellaCalloutFindings`, `UmbrellaPresentSpec`, `UmbrellaSectionRef`, `UmbrellaNotCalledOutFinding` from `./umbrella-callouts.js`.
- Produces:
  - `GraphNodeInput = { readonly specId: string; readonly section: string; readonly title: string }`
  - `GraphRefRowInput = { readonly sourceSpecId: string; readonly targetSection: string; readonly sourceParagraphId: string }`
  - `GraphScopeRef = { readonly type: 'project' | 'library'; readonly id: string }`
  - `GraphNode = { readonly specId: string; readonly section: string; readonly title: string; readonly division: string | null; readonly isUmbrella: boolean }`
  - `GraphEdge = { readonly sourceSpecId: string; readonly targetSection: string; readonly targetSpecId: string | null; readonly citationCount: number; readonly anchors?: readonly string[]; readonly anchorsTruncated?: boolean }`
  - `UmbrellaDivision = { readonly division: string; readonly umbrellaSpecId: string | null; readonly umbrellaPresent: boolean; readonly notCalledOut: readonly { readonly specId: string; readonly section: string }[] }`
  - `ReferenceGraph = { readonly scope: GraphScopeRef; readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[]; readonly umbrella: readonly UmbrellaDivision[]; readonly anchorCap: number; readonly notes: readonly string[] }`
  - `ANCHOR_CAP: number` (= 50)
  - `buildReferenceGraph(scope: GraphScopeRef, nodes: readonly GraphNodeInput[], refRows: readonly GraphRefRowInput[], opts: { readonly includeAnchors: boolean }): ReferenceGraph`

- [ ] **Step 1: Write the failing test**

Create `src/db/queries/reference-graph.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildReferenceGraph, ANCHOR_CAP } from './reference-graph.js';
import type { GraphNodeInput, GraphRefRowInput } from './reference-graph.js';

const scope = { type: 'project', id: 'proj-1' } as const;

function node(specId: string, section: string, title = 't'): GraphNodeInput {
  return { specId, section, title };
}
function ref(sourceSpecId: string, targetSection: string, sourceParagraphId: string): GraphRefRowInput {
  return { sourceSpecId, targetSection, sourceParagraphId };
}

describe('buildReferenceGraph', () => {
  it('marks a division umbrella node and derives division', () => {
    const g = buildReferenceGraph(scope, [node('u', '09 00 00'), node('a', '09 91 00')], [], {
      includeAnchors: false,
    });
    const umbrella = g.nodes.find((n) => n.specId === 'u');
    expect(umbrella).toMatchObject({ division: '09', isUmbrella: true });
    expect(g.nodes.find((n) => n.specId === 'a')).toMatchObject({ division: '09', isUmbrella: false });
  });

  it('resolves an in-scope edge and dangles an out-of-scope target', () => {
    const nodes = [node('a', '03 30 00'), node('b', '09 91 00')];
    const refs = [ref('a', '09 91 00', 'p1'), ref('a', '99 99 00', 'p2')];
    const g = buildReferenceGraph(scope, nodes, refs, { includeAnchors: false });
    const resolved = g.edges.find((e) => e.targetSection === '09 91 00');
    const dangling = g.edges.find((e) => e.targetSection === '99 99 00');
    expect(resolved?.targetSpecId).toBe('b');
    expect(dangling?.targetSpecId).toBeNull();
  });

  it('counts multiple citations of the same target as one edge', () => {
    const refs = [ref('a', '09 91 00', 'p1'), ref('a', '09 91 00', 'p2')];
    const g = buildReferenceGraph(scope, [node('a', '03 30 00'), node('b', '09 91 00')], refs, {
      includeAnchors: false,
    });
    const edge = g.edges.find((e) => e.sourceSpecId === 'a' && e.targetSection === '09 91 00');
    expect(edge?.citationCount).toBe(2);
    expect(edge?.anchors).toBeUndefined();
  });

  it('includes capped anchors and flags truncation when includeAnchors', () => {
    const refs = Array.from({ length: ANCHOR_CAP + 5 }, (_, i) => ref('a', '09 91 00', `p${i}`));
    const g = buildReferenceGraph(scope, [node('a', '03 30 00'), node('b', '09 91 00')], refs, {
      includeAnchors: true,
    });
    const edge = g.edges.find((e) => e.targetSection === '09 91 00');
    expect(edge?.citationCount).toBe(ANCHOR_CAP + 5);
    expect(edge?.anchors).toHaveLength(ANCHOR_CAP);
    expect(edge?.anchorsTruncated).toBe(true);
    expect(g.notes.some((n) => n.includes(String(ANCHOR_CAP)))).toBe(true);
  });

  it('reports umbrella present + subordinate not calling it out', () => {
    const nodes = [node('u', '09 00 00'), node('a', '09 91 00'), node('b', '09 22 00')];
    // a calls out the umbrella; b does not
    const refs = [ref('a', '09 00 00', 'p1')];
    const g = buildReferenceGraph(scope, nodes, refs, { includeAnchors: false });
    const div09 = g.umbrella.find((u) => u.division === '09');
    expect(div09?.umbrellaPresent).toBe(true);
    expect(div09?.umbrellaSpecId).toBe('u');
    expect(div09?.notCalledOut.map((s) => s.specId)).toEqual(['b']);
  });

  it('reports umbrella absent for a division with no {div} 00 00 node', () => {
    const g = buildReferenceGraph(scope, [node('a', '03 30 00')], [], { includeAnchors: false });
    const div03 = g.umbrella.find((u) => u.division === '03');
    expect(div03?.umbrellaPresent).toBe(false);
    expect(div03?.umbrellaSpecId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit src/db/queries/reference-graph.test.ts`
Expected: FAIL — cannot import `buildReferenceGraph` (module has no such export yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/db/queries/reference-graph.ts` (types + pure builder only):

```typescript
import {
  buildUmbrellaCalloutFindings,
  type UmbrellaNotCalledOutFinding,
} from './umbrella-callouts.js';

export const ANCHOR_CAP = 50;

export interface GraphNodeInput {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
}
export interface GraphRefRowInput {
  readonly sourceSpecId: string;
  readonly targetSection: string;
  readonly sourceParagraphId: string;
}
export interface GraphScopeRef {
  readonly type: 'project' | 'library';
  readonly id: string;
}
export interface GraphNode {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly division: string | null;
  readonly isUmbrella: boolean;
}
export interface GraphEdge {
  readonly sourceSpecId: string;
  readonly targetSection: string;
  readonly targetSpecId: string | null;
  readonly citationCount: number;
  readonly anchors?: readonly string[];
  readonly anchorsTruncated?: boolean;
}
export interface UmbrellaDivision {
  readonly division: string;
  readonly umbrellaSpecId: string | null;
  readonly umbrellaPresent: boolean;
  readonly notCalledOut: readonly { readonly specId: string; readonly section: string }[];
}
export interface ReferenceGraph {
  readonly scope: GraphScopeRef;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly umbrella: readonly UmbrellaDivision[];
  readonly anchorCap: number;
  readonly notes: readonly string[];
}

function divisionOf(section: string): string | null {
  return /^(\d{2}) /.exec(section)?.[1] ?? null;
}

function toNode(input: GraphNodeInput): GraphNode {
  const division = divisionOf(input.section);
  return {
    specId: input.specId,
    section: input.section,
    title: input.title,
    division,
    isUmbrella: division !== null && input.section === `${division} 00 00`,
  };
}

// section -> the in-scope spec id that owns it (first by section then specId).
function sectionIndex(nodes: readonly GraphNode[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const n of [...nodes].sort((a, b) => a.section.localeCompare(b.section) || a.specId.localeCompare(b.specId))) {
    if (!index.has(n.section)) index.set(n.section, n.specId);
  }
  return index;
}

interface EdgeGroup {
  readonly sourceSpecId: string;
  readonly targetSection: string;
  readonly anchors: string[];
}

function groupRefs(refRows: readonly GraphRefRowInput[]): EdgeGroup[] {
  const groups = new Map<string, EdgeGroup>();
  for (const r of refRows) {
    const key = `${r.sourceSpecId} ${r.targetSection}`;
    const existing = groups.get(key);
    if (existing) existing.anchors.push(r.sourceParagraphId);
    else groups.set(key, { sourceSpecId: r.sourceSpecId, targetSection: r.targetSection, anchors: [r.sourceParagraphId] });
  }
  return [...groups.values()];
}

function toEdge(
  group: EdgeGroup,
  index: ReadonlyMap<string, string>,
  includeAnchors: boolean
): GraphEdge {
  const base: GraphEdge = {
    sourceSpecId: group.sourceSpecId,
    targetSection: group.targetSection,
    targetSpecId: index.get(group.targetSection) ?? null,
    citationCount: group.anchors.length,
  };
  if (!includeAnchors) return base;
  return {
    ...base,
    anchors: group.anchors.slice(0, ANCHOR_CAP),
    anchorsTruncated: group.anchors.length > ANCHOR_CAP,
  };
}

function sortEdges(edges: readonly GraphEdge[], sectionBySpec: ReadonlyMap<string, string>): GraphEdge[] {
  return [...edges].sort((a, b) => {
    const sa = sectionBySpec.get(a.sourceSpecId) ?? '';
    const sb = sectionBySpec.get(b.sourceSpecId) ?? '';
    return sa.localeCompare(sb) || a.sourceSpecId.localeCompare(b.sourceSpecId) || a.targetSection.localeCompare(b.targetSection);
  });
}

function umbrellaAnnotations(
  nodes: readonly GraphNode[],
  refRows: readonly GraphRefRowInput[]
): UmbrellaDivision[] {
  const present = nodes.map((n) => ({ specId: n.specId, section: n.section }));
  const sectionRefs = refRows.map((r) => ({ sourceSpecId: r.sourceSpecId, value: r.targetSection }));
  const { findings } = buildUmbrellaCalloutFindings(present, sectionRefs);
  const notCalledOutByDiv = new Map<string, { specId: string; section: string }[]>();
  for (const f of findings) {
    const div = f.umbrellaSpecSection.slice(0, 2);
    const list = notCalledOutByDiv.get(div) ?? [];
    list.push({ specId: f.sourceSpecId, section: f.sourceSpecSection });
    notCalledOutByDiv.set(div, list);
  }
  const divisions = [...new Set(nodes.map((n) => n.division).filter((d): d is string => d !== null))].sort();
  return divisions.map((division) => {
    const umbrella = nodes.find((n) => n.section === `${division} 00 00`);
    return {
      division,
      umbrellaSpecId: umbrella?.specId ?? null,
      umbrellaPresent: umbrella !== undefined,
      notCalledOut: (notCalledOutByDiv.get(division) ?? []).sort((a, b) => a.section.localeCompare(b.section)),
    };
  });
}

export function buildReferenceGraph(
  scope: GraphScopeRef,
  nodeInputs: readonly GraphNodeInput[],
  refRows: readonly GraphRefRowInput[],
  opts: { readonly includeAnchors: boolean }
): ReferenceGraph {
  const nodes = nodeInputs.map(toNode).sort((a, b) => a.section.localeCompare(b.section) || a.specId.localeCompare(b.specId));
  const index = sectionIndex(nodes);
  const sectionBySpec = new Map(nodes.map((n) => [n.specId, n.section]));
  const edges = sortEdges(groupRefs(refRows).map((g) => toEdge(g, index, opts.includeAnchors)), sectionBySpec);
  const notes = opts.includeAnchors
    ? [`paragraph anchors included per edge, capped at ${ANCHOR_CAP}; anchorsTruncated flags edges over the cap`]
    : [];
  return {
    scope,
    nodes,
    edges,
    umbrella: umbrellaAnnotations(nodes, refRows),
    anchorCap: ANCHOR_CAP,
    notes,
  };
}

// Re-exported for the DB layer (Task 2) and consumers.
export type { UmbrellaNotCalledOutFinding };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit src/db/queries/reference-graph.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint the new file**

Run: `pnpm exec eslint src/db/queries/reference-graph.ts src/db/queries/reference-graph.test.ts && pnpm exec tsc --noEmit`
Expected: no errors. If `max-lines` (400) trips later when the DB layer lands, extract the pure builder into `reference-graph-build.ts` and re-export from `reference-graph.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/reference-graph.ts src/db/queries/reference-graph.test.ts
git commit -m "feat(db): pure reference-graph builder (nodes, edges, umbrella)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: DB read layer + scope-relative fetch

**Files:**
- Modify: `src/db/queries/reference-graph.ts` (append DB layer)
- Modify: `src/db/queries/libraries.ts` (add `LibraryNotFoundError`)
- Modify: `src/db/index.ts` (barrel exports)
- Test: `src/db/queries/reference-graph.integration.test.ts`

**Interfaces:**
- Consumes: `pool`, `DatabaseError` from `../index.js`; `ProjectNotFoundError` from `./derive.js`; `LibraryNotFoundError` (new) from `./libraries.js`; `getOutboundReferences` from `./refs.js` (in the test, for agreement).
- Produces:
  - `GraphScope = { readonly kind: 'project'; readonly id: string } | { readonly kind: 'library'; readonly id: string }`
  - `getReferenceGraph(scope: GraphScope, opts?: { readonly includeAnchors?: boolean }, db?: Pool): Promise<ReferenceGraph>` — throws `ProjectNotFoundError` / `LibraryNotFoundError` on a missing scope id, `DatabaseError` otherwise.
  - `class LibraryNotFoundError extends DatabaseError` (in `libraries.ts`).

- [ ] **Step 1: Add `LibraryNotFoundError` to `libraries.ts`**

In `src/db/queries/libraries.ts`, next to `ParentLibraryNotFoundError` (around line 127):

```typescript
export class LibraryNotFoundError extends DatabaseError {}
```

- [ ] **Step 2: Write the failing integration test**

Create `src/db/queries/reference-graph.integration.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getReferenceGraph } from './reference-graph.js';
import { getOutboundReferences } from './refs.js';
import { ProjectNotFoundError } from './derive.js';
import { LibraryNotFoundError } from './libraries.js';

const suffix = randomUUID().slice(0, 8);
const source = `rg_${suffix}`;
const specIds: string[] = [];
let projectId: string;
let libraryId: string;
let umbrella: string; // 09 00 00
let painting: string; // 09 91 00 (calls out umbrella + cites 07 92 00 twice)
let gypsum: string; // 09 29 00 (does not call out umbrella; dangling ref to 99 99 00)

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [section, title, `${source}_${section}`, libraryId]
  );
  const id = r.rows[0]!.id;
  specIds.push(id);
  return id;
}
async function addProjectSpec(specId: string, position: number): Promise<void> {
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,$3)`, [
    projectId,
    specId,
    position,
  ]);
}
async function insertRef(
  sourceSpecId: string,
  targetSection: string,
  targetSpecId: string | null
): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1',$2,1) RETURNING id`,
    [sourceSpecId, `ref ${targetSection}`]
  );
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text, is_broken)
     VALUES ($1,$2,'section',$3,$4,$5,$6)`,
    [sourceSpecId, p.rows[0]!.id, targetSection, targetSpecId, `ref ${targetSection}`, targetSpecId === null]
  );
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`RefGraph Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`RefGraph Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;

  umbrella = await insertSpec('09 00 00', 'Finishes General');
  painting = await insertSpec('09 91 00', 'Painting');
  gypsum = await insertSpec('09 29 00', 'Gypsum Board');
  await addProjectSpec(umbrella, 1);
  await addProjectSpec(painting, 2);
  await addProjectSpec(gypsum, 3);

  // painting -> 09 00 00 (umbrella, in scope), painting -> 07 92 00 twice (dangling)
  await insertRef(painting, '09 00 00', umbrella);
  await insertRef(painting, '07 92 00', null);
  await insertRef(painting, '07 92 00', null);
  // gypsum -> 99 99 00 (dangling), no umbrella call-out
  await insertRef(gypsum, '99 99 00', null);
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
});

describe('getReferenceGraph (project scope)', () => {
  it('returns nodes, resolved/dangling edges, citation counts, and umbrella annotations', async () => {
    const g = await getReferenceGraph({ kind: 'project', id: projectId });
    expect(g.nodes.map((n) => n.section)).toEqual(['09 00 00', '09 29 00', '09 91 00']);
    const twoCite = g.edges.find((e) => e.sourceSpecId === painting && e.targetSection === '07 92 00');
    expect(twoCite?.citationCount).toBe(2);
    expect(twoCite?.targetSpecId).toBeNull();
    const resolved = g.edges.find((e) => e.sourceSpecId === painting && e.targetSection === '09 00 00');
    expect(resolved?.targetSpecId).toBe(umbrella);
    const div09 = g.umbrella.find((u) => u.division === '09');
    expect(div09?.umbrellaPresent).toBe(true);
    expect(div09?.notCalledOut.map((s) => s.specId).sort()).toEqual([gypsum].sort());
  });

  it('agrees with getOutboundReferences for each source spec (section refs)', async () => {
    const g = await getReferenceGraph({ kind: 'project', id: projectId });
    const outbound = await getOutboundReferences(painting, projectId, pool);
    const bySection = new Map<string, { count: number; targetSpecId: string | null }>();
    for (const o of outbound) {
      if (o.targetSection === null) continue;
      const cur = bySection.get(o.targetSection) ?? { count: 0, targetSpecId: o.targetSpecId };
      bySection.set(o.targetSection, { count: cur.count + 1, targetSpecId: o.targetSpecId });
    }
    for (const [section, expected] of bySection) {
      const edge = g.edges.find((e) => e.sourceSpecId === painting && e.targetSection === section);
      expect(edge?.citationCount).toBe(expected.count);
      expect(edge?.targetSpecId ?? null).toBe(expected.targetSpecId ?? null);
    }
  });

  it('includes capped anchors when includeAnchors is set', async () => {
    const g = await getReferenceGraph({ kind: 'project', id: projectId }, { includeAnchors: true });
    const twoCite = g.edges.find((e) => e.sourceSpecId === painting && e.targetSection === '07 92 00');
    expect(twoCite?.anchors).toHaveLength(2);
    expect(twoCite?.anchorsTruncated).toBe(false);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(getReferenceGraph({ kind: 'project', id: randomUUID() })).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
  });
});

describe('getReferenceGraph (library scope)', () => {
  it('returns library-scoped nodes and throws for an unknown library', async () => {
    const g = await getReferenceGraph({ kind: 'library', id: libraryId });
    expect(g.nodes.map((n) => n.section)).toEqual(['09 00 00', '09 29 00', '09 91 00']);
    await expect(getReferenceGraph({ kind: 'library', id: randomUUID() })).rejects.toBeInstanceOf(
      LibraryNotFoundError
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `. ./.env && pnpm exec vitest run --project integration src/db/queries/reference-graph.integration.test.ts`
Expected: FAIL — `getReferenceGraph` not exported.

- [ ] **Step 4: Append the DB layer to `reference-graph.ts`**

Add imports at the top of `src/db/queries/reference-graph.ts`:

```typescript
import type { Pool, PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { ProjectNotFoundError } from './derive.js';
import { LibraryNotFoundError } from './libraries.js';
```

Append at the end of the file:

```typescript
export type GraphScope =
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'library'; readonly id: string };

interface NodeRow {
  readonly spec_id: string;
  readonly section: string;
  readonly title: string;
}
interface RefRow {
  readonly source_spec_id: string;
  readonly target_spec_section: string;
  readonly source_paragraph_id: string;
}

async function assertScopeExists(scope: GraphScope, client: PoolClient): Promise<void> {
  if (scope.kind === 'project') {
    const r = await client.query('SELECT 1 FROM projects WHERE id = $1', [scope.id]);
    if ((r.rowCount ?? 0) === 0) throw new ProjectNotFoundError(`project ${scope.id} not found`);
    return;
  }
  const r = await client.query('SELECT 1 FROM libraries WHERE id = $1', [scope.id]);
  if ((r.rowCount ?? 0) === 0) throw new LibraryNotFoundError(`library ${scope.id} not found`);
}

// Withdrawn masters (ADR-030) never appear as nodes — matching coordination's present set.
async function readNodes(scope: GraphScope, client: PoolClient): Promise<GraphNodeInput[]> {
  const sql =
    scope.kind === 'project'
      ? `SELECT s.id AS spec_id, s.section, s.title
           FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
          WHERE ps.project_id = $1 AND s.withdrawn_at IS NULL
          ORDER BY s.section, s.id`
      : `SELECT s.id AS spec_id, s.section, s.title
           FROM specs s
          WHERE s.library_id = $1 AND s.withdrawn_at IS NULL
          ORDER BY s.section, s.id`;
  const r = await client.query<NodeRow>(sql, [scope.id]);
  return r.rows.map((row) => ({ specId: row.spec_id, section: row.section, title: row.title }));
}

async function readSectionRefs(
  specIds: readonly string[],
  client: PoolClient
): Promise<GraphRefRowInput[]> {
  if (specIds.length === 0) return [];
  const r = await client.query<RefRow>(
    `SELECT source_spec_id, target_spec_section, source_paragraph_id
       FROM spec_references
      WHERE source_spec_id = ANY($1::uuid[])
        AND target_type = 'section'
        AND target_spec_section IS NOT NULL`,
    [specIds]
  );
  return r.rows.map((row) => ({
    sourceSpecId: row.source_spec_id,
    targetSection: row.target_spec_section,
    sourceParagraphId: row.source_paragraph_id,
  }));
}

async function assembleGraph(
  scope: GraphScope,
  includeAnchors: boolean,
  client: PoolClient
): Promise<ReferenceGraph> {
  await assertScopeExists(scope, client);
  const nodes = await readNodes(scope, client);
  const refRows = await readSectionRefs(
    nodes.map((n) => n.specId),
    client
  );
  return buildReferenceGraph({ type: scope.kind, id: scope.id }, nodes, refRows, { includeAnchors });
}

export async function getReferenceGraph(
  scope: GraphScope,
  opts: { readonly includeAnchors?: boolean } = {},
  db: Pool = pool
): Promise<ReferenceGraph> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const graph = await assembleGraph(scope, opts.includeAnchors ?? false, client);
    await client.query('COMMIT');
    return graph;
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) throw err;
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getReferenceGraph failed for ${scope.kind} ${scope.id}`, { cause: err });
  } finally {
    if (client) client.release();
  }
}
```

- [ ] **Step 5: Barrel-export from `src/db/index.ts`**

Add (near the `project-refs`/`coordination` exports):

```typescript
export { getReferenceGraph } from './queries/reference-graph.js';
export type {
  ReferenceGraph,
  GraphNode,
  GraphEdge,
  UmbrellaDivision,
  GraphScope,
} from './queries/reference-graph.js';
export { LibraryNotFoundError } from './queries/libraries.js';
```

- [ ] **Step 6: Run test + lint to verify pass**

Run:
```bash
. ./.env && pnpm exec vitest run --project integration src/db/queries/reference-graph.integration.test.ts
pnpm exec eslint src/db/queries/reference-graph.ts src/db/queries/libraries.ts src/db/index.ts && pnpm exec tsc --noEmit
```
Expected: integration tests PASS; lint/typecheck clean. If `reference-graph.ts` exceeds 400 lines, extract the pure builder + types to `src/db/queries/reference-graph-build.ts` and re-import; re-run.

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/reference-graph.ts src/db/queries/reference-graph.integration.test.ts src/db/queries/libraries.ts src/db/index.ts
git commit -m "feat(db): scope-relative getReferenceGraph over refs/paragraph tables

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: REST routes + openapi + API tests

**Files:**
- Create: `src/api/reference-graph.ts`
- Modify: `src/api/router.ts`
- Modify: `openapi.yaml`
- Modify: `src/api/contract.integration.test.ts` (RESPONSE_ALLOWLIST)
- Test: `src/api/reference-graph.integration.test.ts`

**Interfaces:**
- Consumes: `getReferenceGraph`, `ProjectNotFoundError`, `LibraryNotFoundError` from `../db/index.js`.
- Produces: `getProjectReferenceGraphHandler(req, res)`, `getLibraryReferenceGraphHandler(req, res)` (Express handlers).

- [ ] **Step 1: Create the handlers**

Create `src/api/reference-graph.ts`:

```typescript
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  getReferenceGraph,
  ProjectNotFoundError,
  LibraryNotFoundError,
  type GraphScope,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

const UUID = z.uuid();

async function respond(req: Request, res: Response, kind: GraphScope['kind']): Promise<void> {
  const id = UUID.safeParse(req.params['id']);
  if (!id.success) {
    res.status(400).json({ success: false, error: `invalid ${kind} id` });
    return;
  }
  const includeAnchors = req.query['includeAnchors'] === 'true';
  try {
    const graph = await getReferenceGraph({ kind, id: id.data }, { includeAnchors });
    res.status(200).json({ success: true, data: graph });
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) {
      res.status(404).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'reference graph failed');
    res.status(500).json({ success: false, error: 'reference graph failed' });
  }
}

export async function getProjectReferenceGraphHandler(req: Request, res: Response): Promise<void> {
  await respond(req, res, 'project');
}

export async function getLibraryReferenceGraphHandler(req: Request, res: Response): Promise<void> {
  await respond(req, res, 'library');
}
```

- [ ] **Step 2: Wire the routes in `router.ts`**

Add the import (near the other reference handlers, ~line 32):

```typescript
import {
  getProjectReferenceGraphHandler,
  getLibraryReferenceGraphHandler,
} from './reference-graph.js';
```

Add the project route next to the other `/projects/:id/references*` routes (~line 224):

```typescript
router.get('/projects/:id/reference-graph', getProjectReferenceGraphHandler);
```

Add the library route among the `/libraries/:id/...` routes (after `/libraries/:id/specs`, ~line 258):

```typescript
router.get('/libraries/:id/reference-graph', getLibraryReferenceGraphHandler);
```

- [ ] **Step 3: Add openapi paths + schemas**

In `openapi.yaml`, add both paths (place the project path near `/projects/{id}/coordination-report`, the library path near `/libraries/{id}/specs`):

```yaml
  /projects/{id}/reference-graph:
    get:
      operationId: getProjectReferenceGraph
      summary: Project section-reference graph (nodes, edges, umbrella annotations)
      tags: [projects]
      parameters:
        - $ref: '#/components/parameters/ProjectId'
        - name: includeAnchors
          in: query
          required: false
          description: Add capped per-edge paragraph anchor lists (see ReferenceGraph.anchorCap).
          schema: { type: boolean, default: false }
      responses:
        '200':
          description: Reference graph for the project
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data: { $ref: '#/components/schemas/ReferenceGraph' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { $ref: '#/components/responses/NotFound' }
        '500': { $ref: '#/components/responses/InternalServerError' }

  /libraries/{id}/reference-graph:
    get:
      operationId: getLibraryReferenceGraph
      summary: Library section-reference graph (nodes, edges, umbrella annotations)
      tags: [libraries]
      parameters:
        - name: id
          in: path
          required: true
          description: Library UUID
          schema: { type: string, format: uuid }
        - name: includeAnchors
          in: query
          required: false
          description: Add capped per-edge paragraph anchor lists (see ReferenceGraph.anchorCap).
          schema: { type: boolean, default: false }
      responses:
        '200':
          description: Reference graph for the library
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data: { $ref: '#/components/schemas/ReferenceGraph' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { $ref: '#/components/responses/NotFound' }
        '500': { $ref: '#/components/responses/InternalServerError' }
```

Add the schemas (near `CoordinationReport` in `components.schemas`):

```yaml
    ReferenceGraph:
      type: object
      description: >
        One-call section-reference graph for a project or library (#447).
        Edges resolve scope-relative: a target section is resolved to the
        in-scope node that owns it, or null (dangling).
      required: [scope, nodes, edges, umbrella, anchorCap, notes]
      properties:
        scope:
          type: object
          required: [type, id]
          properties:
            type: { type: string, enum: [project, library] }
            id: { type: string, format: uuid }
        nodes:
          type: array
          items: { $ref: '#/components/schemas/ReferenceGraphNode' }
        edges:
          type: array
          items: { $ref: '#/components/schemas/ReferenceGraphEdge' }
        umbrella:
          type: array
          items: { $ref: '#/components/schemas/ReferenceGraphUmbrellaDivision' }
        anchorCap:
          type: integer
          description: Max paragraph anchors emitted per edge when includeAnchors=true.
        notes:
          type: array
          items: { type: string }
    ReferenceGraphNode:
      type: object
      required: [specId, section, title, division, isUmbrella]
      properties:
        specId: { type: string, format: uuid }
        section: { type: string }
        title: { type: string }
        division: { type: [string, 'null'] }
        isUmbrella:
          type: boolean
          description: True when section equals "{division} 00 00".
    ReferenceGraphEdge:
      type: object
      required: [sourceSpecId, targetSection, targetSpecId, citationCount]
      properties:
        sourceSpecId: { type: string, format: uuid }
        targetSection: { type: string }
        targetSpecId:
          type: [string, 'null']
          format: uuid
          description: In-scope spec that owns targetSection, or null when dangling.
        citationCount: { type: integer }
        anchors:
          type: array
          description: Paragraph UUIDs citing the target (only when includeAnchors=true; capped at anchorCap).
          items: { type: string, format: uuid }
        anchorsTruncated:
          type: boolean
          description: True when citationCount exceeded anchorCap (only when includeAnchors=true).
    ReferenceGraphUmbrellaDivision:
      type: object
      required: [division, umbrellaSpecId, umbrellaPresent, notCalledOut]
      properties:
        division: { type: string }
        umbrellaSpecId: { type: [string, 'null'], format: uuid }
        umbrellaPresent: { type: boolean }
        notCalledOut:
          type: array
          description: In-scope specs in the division that never cite its "{division} 00 00" umbrella.
          items:
            type: object
            required: [specId, section]
            properties:
              specId: { type: string, format: uuid }
              section: { type: string }
```

- [ ] **Step 4: Allowlist both ops in the API contract test**

In `src/api/contract.integration.test.ts`, add to `RESPONSE_ALLOWLIST` (near `get /projects/{}/coordination-report`):

```typescript
  'get /projects/{}/reference-graph',
  'get /libraries/{}/reference-graph',
```

- [ ] **Step 5: Write the API integration test**

Create `src/api/reference-graph.integration.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';

const suffix = randomUUID().slice(0, 8);
const specIds: string[] = [];
let server: Server;
let baseUrl: string;
let projectId: string;
let libraryId: string;

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [section, title, `rgapi_${suffix}_${section}`, libraryId]
  );
  const id = r.rows[0]!.id;
  specIds.push(id);
  return id;
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;

  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`RG API Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [
    `RG API Proj ${suffix}`,
  ]);
  projectId = proj.rows[0]!.id;
  const umbrella = await insertSpec('07 00 00', 'Thermal General');
  const membrane = await insertSpec('07 92 00', 'Joint Sealants');
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2)`, [
    projectId,
    umbrella,
    membrane,
  ]);
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1','x',1) RETURNING id`,
    [membrane]
  );
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text, is_broken)
     VALUES ($1,$2,'section','07 00 00',$3,'ref',false)`,
    [membrane, p.rows[0]!.id, umbrella]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('GET /projects/:id/reference-graph', () => {
  it('returns a schema-valid graph', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/reference-graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { nodes: unknown[]; edges: { targetSpecId: string | null }[] } };
    await assertResponse('get', '/projects/{id}/reference-graph', 200, body);
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.edges.some((e) => e.targetSpecId !== null)).toBe(true);
  });

  it('adds anchors when includeAnchors=true', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/reference-graph?includeAnchors=true`);
    const body = (await res.json()) as { data: { edges: { anchors?: string[] }[] } };
    expect(body.data.edges[0]?.anchors?.length).toBeGreaterThan(0);
  });

  it('400 on a bad uuid and 404 on an unknown project', async () => {
    expect((await fetch(`${baseUrl}/projects/not-a-uuid/reference-graph`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/projects/${randomUUID()}/reference-graph`)).status).toBe(404);
  });
});

describe('GET /libraries/:id/reference-graph', () => {
  it('returns a schema-valid library graph and 404s an unknown library', async () => {
    const res = await fetch(`${baseUrl}/libraries/${libraryId}/reference-graph`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/libraries/{id}/reference-graph', 200, await res.json());
    expect((await fetch(`${baseUrl}/libraries/${randomUUID()}/reference-graph`)).status).toBe(404);
  });
});
```

- [ ] **Step 6: Run tests + lint (includes the API contract gate)**

Run:
```bash
. ./.env && pnpm exec vitest run --project integration \
  src/api/reference-graph.integration.test.ts \
  src/api/contract.integration.test.ts
pnpm exec eslint src/api/reference-graph.ts src/api/router.ts src/api/reference-graph.integration.test.ts && pnpm exec tsc --noEmit
pnpm exec prettier --check openapi.yaml src/api/reference-graph.ts
```
Expected: all PASS. The contract gate (`contract.integration.test.ts`) proves both routes are documented and the allowlist entries are present.

- [ ] **Step 7: Commit**

```bash
git add src/api/reference-graph.ts src/api/router.ts src/api/reference-graph.integration.test.ts src/api/contract.integration.test.ts openapi.yaml
git commit -m "feat(api): GET reference-graph routes for project + library (openapi + contract)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: MCP tool + contract binding

**Files:**
- Create: `src/mcp/reference-graph-handler.ts`
- Modify: `src/mcp/report-tools.ts`
- Modify: `src/mcp/contract-map.ts` (`OP_TO_TOOL` + `INV5_READ_PENDING`)
- Modify: `src/mcp/capabilities.ts` (`TOOL_TIERS`)
- Test: `src/mcp/reference-graph.integration.test.ts`

**Interfaces:**
- Consumes: `getReferenceGraph`, `ProjectNotFoundError`, `LibraryNotFoundError` from `../db/index.js`; `ToolError`, `ToolResult` from `./tool-result.js`; `ToolRegistrar` from `./tool-registry.js`.
- Produces: `handleGetReferenceGraph({ projectId?, libraryId?, includeAnchors? }): Promise<ToolResult>`; `registerReferenceGraphTool(reg: ToolRegistrar): void`.

- [ ] **Step 1: Create the MCP handler**

Create `src/mcp/reference-graph-handler.ts`:

```typescript
import {
  getReferenceGraph,
  ProjectNotFoundError,
  LibraryNotFoundError,
  type GraphScope,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function resolveScope(projectId?: string, libraryId?: string): GraphScope | ToolError {
  if ((projectId === undefined) === (libraryId === undefined)) {
    return toolErr('Provide exactly one of projectId or libraryId');
  }
  return projectId !== undefined
    ? { kind: 'project', id: projectId }
    : { kind: 'library', id: libraryId! };
}

export async function handleGetReferenceGraph({
  projectId,
  libraryId,
  includeAnchors,
}: {
  projectId?: string | undefined;
  libraryId?: string | undefined;
  includeAnchors?: boolean | undefined;
}): Promise<ToolResult> {
  const scope = resolveScope(projectId, libraryId);
  if ('isError' in scope) return scope;
  try {
    const graph = await getReferenceGraph(scope, { includeAnchors: includeAnchors ?? false });
    return { content: [{ type: 'text' as const, text: JSON.stringify(graph, null, 2) }] };
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) {
      return toolErr(err.message);
    }
    logger.error({ err }, 'mcp tool get_reference_graph failed');
    return toolErr('Internal error — reference graph failed');
  }
}
```

Note: the `libraryId!` non-null in `resolveScope` violates the no-`!` rule in `src/`. Rewrite `resolveScope` without `!`:

```typescript
function resolveScope(projectId?: string, libraryId?: string): GraphScope | ToolError {
  if (projectId !== undefined && libraryId === undefined) return { kind: 'project', id: projectId };
  if (libraryId !== undefined && projectId === undefined) return { kind: 'library', id: libraryId };
  return toolErr('Provide exactly one of projectId or libraryId');
}
```

- [ ] **Step 2: Register the tool in `report-tools.ts`**

Add the import and call inside `registerReportTools`, plus the registrar:

```typescript
import { handleGetReferenceGraph } from './reference-graph-handler.js';
```

In `registerReportTools`, add `registerReferenceGraphTool(reg);`. Then add:

```typescript
function registerReferenceGraphTool(reg: ToolRegistrar): void {
  reg.register(
    'get_reference_graph',
    {
      description:
        'One-call section-reference graph for a whole project or library (#447). ' +
        'Returns nodes (in-scope specs: specId, section, title, division, isUmbrella ' +
        'for a "{division} 00 00" section), edges (section references: sourceSpecId, ' +
        'targetSection, scope-resolved targetSpecId or null when dangling, citationCount), ' +
        'and umbrella annotations per division (umbrella present/absent + subordinate ' +
        'specs that never call it out). Set includeAnchors=true to add capped per-edge ' +
        'paragraph-anchor lists (see anchorCap in the result). Provide EXACTLY ONE of ' +
        'projectId (see list_projects) or libraryId (see list_libraries).',
      inputSchema: {
        projectId: z.uuid().optional().describe('Project UUID — graph for this project'),
        libraryId: z.uuid().optional().describe('Library UUID — graph for this library'),
        includeAnchors: z
          .boolean()
          .optional()
          .describe('Add capped per-edge paragraph anchor lists (default false)'),
      },
    },
    handleGetReferenceGraph
  );
}
```

- [ ] **Step 3: Bind the contract (contract-map + capabilities)**

In `src/mcp/contract-map.ts`, add to `OP_TO_TOOL` (both ops → one tool, like `open_comments_report`):

```typescript
  ['get /projects/{}/reference-graph', 'get_reference_graph'], // #447 read model
  ['get /libraries/{}/reference-graph', 'get_reference_graph'],
```

Add to `INV5_READ_PENDING` (needs a seeded fixture graph to drive; defers INV-5 schema-driving):

```typescript
  'get_reference_graph',
```

In `src/mcp/capabilities.ts`, add to `TOOL_TIERS` (reads block):

```typescript
  ['get_reference_graph', 'read'],
```

- [ ] **Step 4: Write the MCP integration test**

Create `src/mcp/reference-graph.integration.test.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleGetReferenceGraph } from './reference-graph-handler.js';

const suffix = randomUUID().slice(0, 8);
const specIds: string[] = [];
let projectId: string;
let libraryId: string;

function parse(res: Awaited<ReturnType<typeof handleGetReferenceGraph>>): { nodes: unknown[] } {
  if ('isError' in res && res.isError) throw new Error(res.content[0]?.text ?? 'error');
  return JSON.parse(res.content[0]!.text as string);
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`RG MCP Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [
    `RG MCP Proj ${suffix}`,
  ]);
  projectId = proj.rows[0]!.id;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('26 00 00','Electrical General',$1,$2) RETURNING id`,
    [`rgmcp_${suffix}`, libraryId]
  );
  specIds.push(s.rows[0]!.id);
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1)`, [
    projectId,
    s.rows[0]!.id,
  ]);
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
});

describe('handleGetReferenceGraph', () => {
  it('returns a project graph', async () => {
    expect(parse(await handleGetReferenceGraph({ projectId })).nodes).toHaveLength(1);
  });
  it('returns a library graph', async () => {
    expect(parse(await handleGetReferenceGraph({ libraryId })).nodes).toHaveLength(1);
  });
  it('errors when neither or both scopes are given', async () => {
    expect('isError' in (await handleGetReferenceGraph({}))).toBe(true);
    expect('isError' in (await handleGetReferenceGraph({ projectId, libraryId }))).toBe(true);
  });
  it('errors on an unknown project', async () => {
    const res = await handleGetReferenceGraph({ projectId: randomUUID() });
    expect('isError' in res && res.isError).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests + lint (includes the MCP contract gate)**

Run:
```bash
. ./.env && pnpm exec vitest run --project integration \
  src/mcp/reference-graph.integration.test.ts \
  src/mcp/contract.integration.test.ts
pnpm exec eslint src/mcp/reference-graph-handler.ts src/mcp/report-tools.ts src/mcp/contract-map.ts src/mcp/capabilities.ts src/mcp/reference-graph.integration.test.ts && pnpm exec tsc --noEmit
```
Expected: all PASS. The MCP contract gate proves INV-1 (both ops covered), INV-2/2b (tool mapped + registered), INV-3 (tier present), and INV-5 completeness (tool in `INV5_READ_PENDING`).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/reference-graph-handler.ts src/mcp/report-tools.ts src/mcp/contract-map.ts src/mcp/capabilities.ts src/mcp/reference-graph.integration.test.ts
git commit -m "feat(mcp): get_reference_graph read tool bound to both REST ops

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: ADR + full verification

**Files:**
- Create: `docs/adr/063-reference-graph-scope-relative-resolution.md`

- [ ] **Step 1: Write ADR-063**

Create `docs/adr/063-reference-graph-scope-relative-resolution.md`:

```markdown
# ADR-063: Reference-graph edges resolve scope-relative

## Status
Accepted

## Context
Issue #447 adds a one-call section-reference graph per project/library. Each edge
must carry a "resolved target spec id (null = dangling)". The DB already stores
`spec_references.target_spec_id`, but that column is resolved differently per owner:
- Project copies: `cloneRefs` (derive.ts) resolves it **project-scoped** at clone
  time, repairing/breaking as sections are added/removed.
- Library masters: `insertRefs` resolves it via a **global** `SELECT id FROM specs
  WHERE section = $1 LIMIT 1` — it can point at a spec in any library, or a project
  copy. It is not library-relative.

A graph must connect nodes that are actually in the graph. Trusting the stored
column would produce library edges pointing outside the node set.

## Decision
Resolve every edge's `targetSpecId` in code by matching its target section against
the in-scope node set (`section -> specId` index built from the graph's own nodes).
Applied uniformly to both scopes.

## Consequences
- For projects, scope-relative resolution **coincides** with the stored
  `target_spec_id` (both are project-scoped), so the graph agrees with the per-spec
  `getOutboundReferences` endpoint — pinned by a test.
- For libraries, edges correctly resolve within the library instead of leaking to
  global matches.
- Dangling = "target section absent from this scope", which is what a graph/coordination
  consumer means. It does not read the stored `is_broken` flag.
- Umbrella annotations reuse `buildUmbrellaCalloutFindings` (ADR-042) unchanged.
```

- [ ] **Step 2: Full green-bar verification**

Run:
```bash
pnpm lint
pnpm test
. ./.env && pnpm exec vitest run --project integration \
  src/db/queries/reference-graph.integration.test.ts \
  src/api/reference-graph.integration.test.ts \
  src/mcp/reference-graph.integration.test.ts \
  src/api/contract.integration.test.ts \
  src/mcp/contract.integration.test.ts
```
Expected: lint clean, all unit tests PASS, all listed integration tests PASS (both contract gates green).

- [ ] **Step 3: Commit**

```bash
git add docs/adr/063-reference-graph-scope-relative-resolution.md
git commit -m "docs(adr): ADR-063 reference-graph scope-relative edge resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes (spec coverage)

- `GET /projects/{id}/reference-graph` + `GET /libraries/{id}/reference-graph` → Task 3.
- nodes with id/section/title/division/isUmbrella → Task 1 (`toNode`), Task 3 (schema).
- edges with source/target/resolved-target/citationCount + optional capped anchors + cap noted → Task 1 (`toEdge`, `notes`, `anchorCap`), Task 3 (schema).
- umbrella per division (present/absent + not-called-out, reusing ADR-042 machinery) → Task 1 (`umbrellaAnnotations`).
- No migration → confirmed (pure read model).
- MCP `get_reference_graph` (read tier) + contract-map entry → Task 4.
- Tests: dangling ref, umbrella not-called-out, citation-count>1, anchor cap → Task 1 unit; agreement with per-spec endpoints → Task 2 integration.
- Sized for 100+ specs → edges aggregated per (source,target); anchors capped at 50.
```
