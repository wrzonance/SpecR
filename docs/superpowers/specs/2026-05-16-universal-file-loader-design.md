# Universal File Loader — Design Spec

**Date:** 2026-05-16
**Issue:** #58
**Status:** Approved

## Overview

Format-agnostic bulk ingest of spec files into the SpecR library. Accepts `.SEC`, `.docx`, and any format supported by the existing `parse()` orchestrator. Surfaces as a CLI script (`pnpm load:files`) and an MCP tool (`load_files`). The UFGS corpus seed (`pnpm seed:corpus`) is a preset invocation, not a special implementation.

## Architecture

```
src/parser/index.ts          ← add parse(buffer, filename): CsiTree dispatcher
src/db/queries/specs.ts      ← extract persistParsedSpec() from mcp/tools.ts
src/db/index.ts              ← re-export persistParsedSpec
src/lib/file-loader.ts       ← loadFiles(paths, opts?): Promise<LoadResult>
scripts/load-files.ts        ← CLI entry; accepts glob/path args
src/mcp/tools.ts             ← add load_files tool; use imported persistParsedSpec
tests/unit/file-loader.test.ts
tests/integration/file-loader.integration.test.ts
package.json                 ← seed:corpus + load:files scripts
README.md                    ← updated Commands + MCP Tools sections
```

### Prerequisite extractions (no new behaviour)

**`src/parser/index.ts`** — add unified dispatcher:
```typescript
export function parse(buffer: Buffer, filename: string): CsiTree {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') return parseSec(buffer);
  if (ext === '.docx') return parseDocx(buffer);
  throw new ParserError(`unsupported format: ${ext}`);
}
```

**`src/db/queries/specs.ts`** — move `persistParsedSpec(tree): Promise<string>` here from `src/mcp/tools.ts`. Re-export from `src/db/index.ts`. Update `src/mcp/tools.ts` to import from `'../db/index.js'`. Partially resolves issue #53.

### `src/lib/file-loader.ts`

```typescript
export interface LoadResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
}

export interface LoadOptions {
  dryRun?: boolean;
  onProgress?: (done: number, total: number, file: string, ok: boolean) => void;
}

export async function loadFiles(paths: string[], opts?: LoadOptions): Promise<LoadResult>
```

- Reads each file as a `Buffer`
- Calls `parse(buffer, filename)` — the new unified dispatcher in `src/parser/index.ts`
- On success (and `!dryRun`): calls `persistParsedSpec(tree)` from `src/db/index.ts`
- Per-file errors caught and collected; never rethrows; always continues
- `onProgress` fires after each file regardless of outcome

### `scripts/load-files.ts`

- Accepts glob patterns and/or explicit paths as CLI args (`process.argv.slice(2)`)
- Resolves globs using Node.js built-in `fs.glob` (Node 22+ — no new dependency)
- Calls `loadFiles()` with `onProgress` → prints one line per file to stdout
- Prints final summary: total / succeeded / failed; lists errors (capped at 20 in display)
- Exits with code 1 if `failed > 0`

### MCP tool: `load_files`

```typescript
inputSchema: {
  glob: z.string().optional().describe('Glob pattern relative to project root'),
  paths: z.array(z.string()).optional().describe('Explicit file paths'),
  dry_run: z.boolean().optional().describe('Parse but skip persist'),
}
```

- Requires at least one of `glob` or `paths`
- Resolves glob (if provided), merges with explicit paths, calls `loadFiles()`
- Returns `LoadResult` as JSON text content
- Returns `{ isError: true, content: [...] }` on glob resolution failure

### `package.json` scripts

```json
"load:files": "tsx scripts/load-files.ts",
"seed:corpus": "pnpm load:files 'docs/references/UFGS/**/*.SEC'"
```

## Data Flow

```
CLI args / MCP input
    │
    ▼
fast-glob(pattern) → string[]   (sorted, deterministic)
    │
    ▼  for each path
readFile(path) → Buffer
    │
    ▼
parse(buffer, filename)         ← format from extension; existing orchestrator
    │
    ├─ success → persistParsedSpec(tree)   [skipped if dryRun]
    │               ├─ success → succeeded++
    │               └─ error   → failed++, errors.push(...)
    │
    └─ error → failed++, errors.push(...)
    │
    ▼
onProgress(done, total, file, ok)
    │
    ▼
return LoadResult
```

## Error Handling

| Site | Error type | Handling |
|------|-----------|---------|
| Glob resolves to 0 files | — | Return zero-result LoadResult; not an error |
| `readFile()` | ENOENT, EACCES | Caught per-file; appended to `errors[]` |
| `parse()` | `ParserError` | Caught per-file; appended to `errors[]` |
| `persistParsedSpec()` | DB error | Caught per-file; appended to `errors[]` |
| Glob pattern itself throws | Invalid pattern | Bubbles up; CLI exits non-zero; MCP returns `isError: true` |

`LoadResult.errors` is uncapped — all failures reported. CLI display truncates at 20 with "…and N more" message.

`dryRun` mode: parse runs, `persistParsedSpec` never called. `succeeded` counts files that parsed successfully. Useful for validating a corpus before committing to DB writes.

## Testing

### Unit tests (`tests/unit/file-loader.test.ts`)

Mock `parse()`, `persistParsedSpec()`, and `fs.readFile`. No DB required.

| Test | Asserts |
|------|---------|
| All files succeed | `succeeded === total`, `failed === 0`, `errors === []` |
| `parse()` throws on one file | `failed === 1`, error captured, remaining files processed |
| `persistParsedSpec()` throws on one file | Same isolation |
| `readFile` throws ENOENT | Captured, continues |
| `dryRun: true` | `persistParsedSpec` never called; succeeded counts parse successes |
| Empty path list | Returns `{ total: 0, succeeded: 0, failed: 0, errors: [] }` |
| `onProgress` callback | Fires once per file with correct `(done, total, file, ok)` args |

### Integration tests (`tests/integration/file-loader.integration.test.ts`)

Real DB, real parser, small fixture set (2–3 .SEC + 1 .docx).

| Test | Asserts |
|------|---------|
| Load known .SEC fixtures | Rows present in `specs` + `paragraphs` tables |
| Idempotent re-run | No duplicate rows; `succeeded` count identical on second run |
| Load .docx fixture | Persisted correctly — proves format-agnostic path works |

### MCP integration (`tests/integration/mcp.integration.test.ts`)

Extend existing MCP test suite.

| Test | Asserts |
|------|---------|
| `load_files` with valid glob | Returns `LoadResult` JSON; no `isError` |
| `load_files` with no-match glob | Returns zero-result; not an error response |

### Not tested in CI

`pnpm seed:corpus` (all 665 files) — run manually; too slow for CI. Covered by idempotent re-run integration test with small fixture set.

## Out of Scope

- Authentication / rate limiting on `load_files` MCP tool (tracked: issue #54)
- Concurrency / parallel file processing (sequential is sufficient for 665 files at ~50ms each)
- Progress streaming back to MCP caller (MCP is stateless; synchronous return is fine)
- Format auto-detection beyond extension (MIME sniffing, magic bytes) — `parse()` handles this if needed later
- Web UI for bulk import

## README Updates (in-scope)

- **Commands section**: add `pnpm load:files` and `pnpm seed:corpus` with descriptions
- **MCP Tools section**: add `load_files` tool entry
- **Phase status table**: Phase 2c still "next"; this is a standalone utility, not a phase gate
- PR description: `Closes #58`
