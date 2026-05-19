# Issue #53 — Extract persistSpec refactor

**Status:** Approved 2026-05-18 — ready for plan + implementation
**Issue:** https://github.com/wrzonance/SpecR/issues/53
**Branch:** `feat/issue-53`

## Context

Issue #53 was filed expecting `persistTree` in `src/api/parse.ts` and `persistParsedSpec` in `src/mcp/tools.ts` to be verbatim duplicates that would silently desync when Phase 3 adds reference insertion.

Inspection on 2026-05-18 found a different state: the MCP path already uses a shared `persistParsedSpec` in `src/db/queries/specs.ts` (called from `src/mcp/handlers.ts` and `src/lib/file-loader.ts`). The API path still uses its private `persistTree`. The functions have **diverged**:

| Behavior | `persistTree` (api/parse.ts) | `persistParsedSpec` (db/queries/specs.ts) |
|----------|------------------------------|-------------------------------------------|
| Insert mode | `createSpec` helper, fails on conflict | `INSERT … ON CONFLICT (section, source) DO UPDATE` |
| Refs persistence | None | `insertRefs(refs, specId, client)` |
| Replace-on-reparse | None | `DELETE FROM spec_references` + `DELETE FROM paragraphs` first |
| Error wrapping | Raw rethrow | `DatabaseError(..., { cause })` |
| Rollback | Single attempt | Best-effort nested try |

Worker output already emits `refs` (see `parser/index.ts:22 ParseResult.refs`), but `api/parse.ts:workerOutputSchema` does not validate the field, so Zod silently strips it before `persistTree` is called. The API path persists specs **without their references** today.

This PR consolidates onto `persistParsedSpec` from the API path, picking up three bug-flavored behavior changes in the process.

## Decision

**Full inheritance.** Replace `persistTree` in `src/api/parse.ts` with a call to `persistParsedSpec`. API path inherits: refs persistence, upsert semantics, replace-on-reparse, error wrapping.

Behavior changes are intentional fixes. PR description must enumerate them.

## Files changed

| File | Change |
|------|--------|
| `src/api/parse.ts` | Delete `persistTree`. Extend `workerOutputSchema` to validate `refs`. Replace `persistTree(finalTree)` call with `persistParsedSpec({ tree: finalTree, refs: workerOutput.refs })`. Drop unused `createSpec` + `pool` imports. |
| `src/ast/schemas.ts` | Add `SecRefSchema` Zod schema matching `SecRef` interface. |
| `src/api/parse.test.ts` | Update mocks: `createSpec` → `persistParsedSpec`. Assert refs from worker flow through to `persistParsedSpec`. |
| `src/api/parse.integration.test.ts` (existing or new) | Cover the three behavior changes: refs persisted; re-upload upserts; re-upload replaces paragraphs + refs. |

No changes to `persistParsedSpec` itself — already does what is needed.

## Schema definition for refs (`src/ast/schemas.ts`)

```typescript
export const SecRefSchema = z.object({
  sourceNodeId: z.string(),
  targetType: z.enum(['section', 'standard']),
  targetSpecSection: z.string().optional(),
  standardCode: z.string().optional(),
  referenceText: z.string(),
});
```

Mirrors `SecRef` interface in `src/ast/types.ts`. Per CLAUDE.md project convention (`src/ast/schemas.ts` — Zod schemas for all AST node types), this schema belongs alongside existing AST schemas, not inline in `api/parse.ts`.

## Worker output schema extension (`src/api/parse.ts`)

```typescript
import { SecRefSchema } from '../ast/schemas.js';

const workerOutputSchema = z.object({
  tree: z.object({
    id: z.string(),
    section: z.string(),
    title: z.string(),
    parts: z.array(z.unknown()),
    warnings: z.array(ParseWarningSchema).optional(),
  }),
  refs: z.array(SecRefSchema).default([]),
  capabilities: z.array(z.string()).optional(),
});
```

`.default([])` — DOCX worker path returns `refs: []` per current MCP code; other formats may emit populated arrays. Default keeps validation passing for both cases.

## Call site replacement (`src/api/parse.ts`)

Before (lines 91–107, 144):

```typescript
async function persistTree(tree: SpecTree): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = tree.parts[0]?.meta.source ?? 'unknown';
    const specId = await createSpec({ section: tree.section, title: tree.title, source }, client);
    const treeWithId: SpecTree = { ...tree, id: specId };
    await insertTree(treeWithId, specId, client);
    await client.query('COMMIT');
    return specId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
// …
const specId = await persistTree(finalTree);
```

After:

```typescript
import { persistParsedSpec, insertTree } from '../db/index.js';
// (drop createSpec + pool imports if unused elsewhere in file)

// (persistTree deleted entirely)

// processParseJob:
const specId = await persistParsedSpec({
  tree: finalTree,
  refs: parsedWorkerOutput.refs,
});
```

`parsedWorkerOutput` is the parsed `workerOutputSchema.parse(workerRaw)` result, already named `tree`/`capabilities` in current code — rename the destructure to also extract `refs`.

## Behavior changes (PR description must enumerate)

1. **Refs persistence.** Workers emit `refs`; `persistParsedSpec` inserts them into `spec_references`. Previously dropped silently on the API path.
2. **Upsert on `(section, source)`.** Re-POSTing the same fixture returns the same `specId` (UPDATE) instead of failing on the unique constraint or creating a duplicate.
3. **Replace-on-reparse.** `persistParsedSpec` `DELETE`s old `spec_references` + `paragraphs` for the spec before reinserting. Re-parse yields a clean tree, no stale rows.

All three preserve the API response contract (`{ specId, section, title, nodeCount, ... }`). No HTTP behavior change.

## Tests

### Unit (`src/api/parse.test.ts`)

- Mock `persistParsedSpec` instead of `createSpec`
- Assert it is called with `{ tree: finalTree, refs: [<from worker>] }`
- Assert returned `specId` propagates to the job result payload
- Cover: worker returns `refs: []` → `persistParsedSpec` called with empty array
- Cover: worker returns populated `refs` → array passes through unchanged
- Cover: worker omits `refs` (legacy schema shape) → `.default([])` produces `[]`

### Integration (`src/api/parse.integration.test.ts`)

- Full POST `/parse` with a fixture that contains references; after job completes, `SELECT * FROM spec_references WHERE source_spec_id = $1` returns the expected rows
- POST same fixture twice; both jobs return identical `specId` (upsert behavior)
- After second POST, paragraph IDs from the first POST are gone (`SELECT id FROM paragraphs WHERE spec_id = $1` set has fully changed); refs replaced
- `pnpm lint`, `pnpm test`, `pnpm test:integration` green

## Acceptance criteria

- [ ] `persistTree` function removed from `src/api/parse.ts`
- [ ] `workerOutputSchema` validates `refs` via `SecRefSchema`
- [ ] `SecRefSchema` exists in `src/ast/schemas.ts`
- [ ] `processParseJob` calls `persistParsedSpec({ tree, refs })`
- [ ] Unit + integration tests cover the three behavior changes
- [ ] PR description enumerates the three behavior changes
- [ ] `grep -n 'persistTree\|createSpec' src/api/parse.ts` returns zero hits for `persistTree`; `createSpec` only if still imported (should be removed)
- [ ] `pnpm lint`, `pnpm test`, `pnpm test:integration` pass
- [ ] PR LOC delta well under 500 (target ~80)

## Out of scope

| Excluded | Reason |
|----------|--------|
| Deleting `createSpec` from `db/queries/specs.ts` | Still used by 4 test files + `src/db/index.ts` barrel — keep public |
| Worker-side changes | Workers already emit `refs`; no worker code touched |
| Schema migrations | None needed; tables (`specs`, `paragraphs`, `spec_references`) already exist |
| New API endpoints | Pure internal refactor; response shape unchanged |
| Phase 3 merge module (`src/merge/`) | Tracked separately under #34/#35/#36 |

## Risk notes

- **Test fixture refs:** Integration test needs a fixture whose parser output produces `refs`. SEC parser produces refs; verify a fixture under `tests/fixtures/sec/` works. DOCX path emits `refs: []` so it won't exercise ref persistence on its own.
- **Upsert collision tests:** Existing `specs_section_source_unique` constraint behavior changes from "POST fails on duplicate" to "POST updates existing". Any external caller depending on conflict failure (none known) would break — call out in PR.
- **Replace-on-reparse implications:** If anything outside `spec_references` + `paragraphs` references a spec (e.g., future `revit_parameter_mappings` from #46), `DELETE` cascade applies via FK chain. Today nothing else does. After #46 merges, mappings would also vanish on re-parse — expected behavior (mappings belong to specific paragraph IDs that are about to be replaced).
