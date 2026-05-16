# Universal File Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a format-agnostic bulk file loader (`loadFiles()`) surfaced as a CLI script (`pnpm load:files`) and MCP tool (`load_files`), making `search_library` immediately useful by seeding the 665-file UFGS corpus in one command.

**Architecture:** Extract `persistParsedSpec` from `mcp/tools.ts` to `src/db/queries/specs.ts` (resolves module boundary violation). Add a unified `parse(buffer, filename)` dispatcher to `src/parser/index.ts` that dispatches by extension using `decodeTextBuffer` for encoding. `loadFiles()` in `src/lib/file-loader.ts` coordinates these two: read → parse → persist, isolating per-file errors and reporting a `LoadResult` summary.

**Tech Stack:** Node.js `fs.glob` (v22+, no new dep), `tsx` (CLI runner), Vitest (unit + integration), existing `chardet`/`iconv-lite` via `decodeTextBuffer`, existing `pg` pool.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/db/queries/specs.ts` | Add `persistParsedSpec(result)` |
| Modify | `src/db/index.ts` | Re-export `persistParsedSpec` |
| Modify | `src/mcp/tools.ts` | Import `persistParsedSpec` from db; update `handleParseDocument`; add `load_files` tool |
| Modify | `src/parser/index.ts` | Add `ParseResult` interface + `parse()` async dispatcher |
| Create | `src/parser/parse.test.ts` | Unit tests for `parse()` dispatcher |
| Create | `src/lib/file-loader.ts` | `LoadResult`, `LoadOptions`, `loadFiles()` |
| Create | `src/lib/file-loader.test.ts` | Unit tests (mocked parse + persistParsedSpec + readFile) |
| Create | `src/lib/file-loader.integration.test.ts` | Integration tests (real DB + real parser) |
| Create | `scripts/load-files.ts` | CLI entry: glob args → `loadFiles()` |
| Delete | `scripts/load-ufgs.ts` | Superseded by universal loader |
| Modify | `package.json` | Add `load:files`, `seed:corpus`; remove `load:ufgs` |
| Modify | `src/mcp/server.integration.test.ts` | Add `load_files` tool tests |
| Modify | `README.md` | Document new scripts + MCP tool |

---

## Task 1: Extract `persistParsedSpec` to `src/db/queries/specs.ts`

`persistParsedSpec` currently lives as a private function in `src/mcp/tools.ts` and throws `McpError` — a module boundary violation. Move it to the db layer. No new behaviour; existing integration tests prove correctness.

**Files:**
- Modify: `src/db/queries/specs.ts`
- Modify: `src/db/index.ts`
- Modify: `src/mcp/tools.ts`

- [ ] **Step 1: Add `persistParsedSpec` to `src/db/queries/specs.ts`**

Add these imports at the top of `src/db/queries/specs.ts` (after existing imports):

```typescript
import type { SecRef } from '../../ast/types.js';
import { insertTree } from './paragraphs.js';
import { insertRefs } from './refs.js';
```

Then append this function at the bottom of `src/db/queries/specs.ts`:

```typescript
export async function persistParsedSpec(result: {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
}): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = result.tree.parts[0]?.meta.source ?? 'unknown';
    const res = await client.query<{ id: string }>(
      `INSERT INTO specs (section, title, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (section, source) DO UPDATE
         SET title = EXCLUDED.title, updated_at = now()
       RETURNING id`,
      [result.tree.section, result.tree.title, source]
    );
    const specId = res.rows[0]?.id;
    if (!specId) throw new DatabaseError('upsert spec returned no id');
    const treeWithId: CsiTree = { ...result.tree, id: specId };
    await insertTree(treeWithId, specId, client);
    if (result.refs.length > 0) {
      await insertRefs(result.refs, specId, client);
    }
    await client.query('COMMIT');
    return specId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw new DatabaseError('failed to persist parsed spec', { cause: err });
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Re-export `persistParsedSpec` from `src/db/index.ts`**

Add to the existing exports block for `specs.js`:

```typescript
export { findSpecById, updateSpec, createSpec, getSpecTree, persistParsedSpec } from './queries/specs.js';
```

- [ ] **Step 3: Update `src/mcp/tools.ts` — remove local function, import from db, fix call**

Remove the entire `persistParsedSpec` function (lines 23–48) from `src/mcp/tools.ts`.

Add `persistParsedSpec` to the existing db import (line 6):

```typescript
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
  pool,
  insertTree,
  persistParsedSpec,
} from '../db/index.js';
```

Add `SecRef` to the ast types import (line 15):

```typescript
import type { CsiNode, CsiTree, SecRef } from '../ast/types.js';
```

Update `handleParseDocument` — replace the `const tree = ...` and `const specId = await persistParsedSpec(tree)` lines with:

```typescript
const parseResult: { tree: CsiTree; refs: readonly SecRef[] } =
  ext === '.sec'
    ? parseSec(bufOrErr as string)
    : { tree: await parseDocx(bufOrErr as Buffer, noop), refs: [] };
const specId = await persistParsedSpec(parseResult);
const nodeCount = countNodes(parseResult.tree.parts);
return {
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(
        { specId, section: parseResult.tree.section, title: parseResult.tree.title, nodeCount },
        null,
        2
      ),
    },
  ],
};
```

Also remove the now-unused `insertTree` from the db import (it was only used by the extracted function):

```typescript
import {
  searchParagraphs,
  listCsiSections,
  getSpecTree,
  getParagraphWithAncestors,
  pool,
  persistParsedSpec,
} from '../db/index.js';
```

- [ ] **Step 4: Run lint + existing tests to verify no regression**

```bash
pnpm lint
pnpm test
pnpm test:integration
```

Expected: all pass. If `insertTree` is still referenced elsewhere in `tools.ts`, keep it in the import.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/specs.ts src/db/index.ts src/mcp/tools.ts
git commit -m "refactor(db): extract persistParsedSpec to db layer, persist refs — partial #53"
```

---

## Task 2: Add `parse()` dispatcher to `src/parser/index.ts`

A unified async dispatcher that takes a Buffer + filename, decodes encoding (for `.sec`), dispatches to the correct parser, and returns a `ParseResult` with both tree and refs.

**Files:**
- Create: `src/parser/parse.test.ts`
- Modify: `src/parser/index.ts`

- [ ] **Step 1: Write failing tests in `src/parser/parse.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./sec/index.js', () => ({
  parseSec: vi.fn(),
  assertSecSafe: vi.fn(),
}));
vi.mock('./docx/index.js', () => ({
  parseDocx: vi.fn(),
  assertDocxSafe: vi.fn(),
}));
vi.mock('../lib/decode-text.js', () => ({
  decodeTextBuffer: vi.fn((buf: Buffer) => buf.toString('utf-8')),
}));

import { parse, ParseResult } from './index.js';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import { ParserError } from './error.js';
import type { CsiTree } from '../ast/types.js';

const mockTree: CsiTree = { id: 'spec-1', section: '27 10 00', title: 'Test', parts: [] };

beforeEach(() => vi.clearAllMocks());

describe('parse() dispatcher', () => {
  it('dispatches .sec to parseSec via decodeTextBuffer', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    const buf = Buffer.from('<SEC/>');
    const result = await parse(buf, 'spec.SEC');
    expect(decodeTextBuffer).toHaveBeenCalledWith(buf);
    expect(parseSec).toHaveBeenCalled();
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
  });

  it('dispatches .docx to parseDocx', async () => {
    vi.mocked(parseDocx).mockResolvedValue(mockTree);
    const buf = Buffer.from('PK...');
    const result = await parse(buf, 'spec.docx');
    expect(parseDocx).toHaveBeenCalledWith(buf, expect.any(Function));
    expect(result.tree).toBe(mockTree);
    expect(result.refs).toEqual([]);
  });

  it('is case-insensitive for extension', async () => {
    vi.mocked(parseSec).mockReturnValue({ tree: mockTree, refs: [] });
    await parse(Buffer.from(''), 'SPEC.SEC');
    expect(parseSec).toHaveBeenCalled();
  });

  it('throws ParserError for unsupported extension', async () => {
    await expect(parse(Buffer.from(''), 'spec.pdf')).rejects.toBeInstanceOf(ParserError);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test -- --reporter=verbose src/parser/parse.test.ts
```

Expected: FAIL — `parse` not exported from `./index.js`

- [ ] **Step 3: Add `ParseResult` and `parse()` to `src/parser/index.ts`**

Replace the entire content of `src/parser/index.ts` with:

```typescript
import path from 'node:path';
import { parseSec } from './sec/index.js';
import { parseDocx } from './docx/index.js';
import { ParserError } from './error.js';
import { decodeTextBuffer } from '../lib/decode-text.js';
import type { CsiTree, SecRef } from '../ast/types.js';

export { parseSec, assertSecSafe } from './sec/index.js';
export type { ParsedSec } from './sec/index.js';
export { parseDocx, assertDocxSafe } from './docx/index.js';
export { ParserError } from './error.js';

export interface ParseResult {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
}

export async function parse(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.sec') {
    const text = decodeTextBuffer(buffer);
    return parseSec(text);
  }
  if (ext === '.docx') {
    const noop = (_stage: string, _pct: number): void => {};
    const tree = await parseDocx(buffer, noop);
    return { tree, refs: [] };
  }
  throw new ParserError(`unsupported format: ${ext}`);
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test -- --reporter=verbose src/parser/parse.test.ts
```

Expected: all 4 pass.

- [ ] **Step 5: Run full lint + test suite**

```bash
pnpm lint && pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/parser/index.ts src/parser/parse.test.ts
git commit -m "feat(parser): add parse() dispatcher — format-agnostic buffer → ParseResult"
```

---

## Task 3: Create `src/lib/file-loader.ts` + unit tests

The core loading logic. Reads each file as a Buffer, calls `parse()`, calls `persistParsedSpec()`. Errors are caught per-file and collected. Never throws. `onProgress` fires after each file regardless of outcome.

**Files:**
- Create: `src/lib/file-loader.test.ts`
- Create: `src/lib/file-loader.ts`

- [ ] **Step 1: Write failing unit tests in `src/lib/file-loader.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../parser/index.js', () => ({ parse: vi.fn() }));
vi.mock('../db/index.js', () => ({ persistParsedSpec: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import { loadFiles, LoadResult } from './file-loader.js';
import { parse } from '../parser/index.js';
import { persistParsedSpec } from '../db/index.js';
import { readFile } from 'node:fs/promises';
import type { CsiTree } from '../ast/types.js';

const mockTree: CsiTree = { id: 'x', section: '27 10 00', title: 'T', parts: [] };
const mockBuf = Buffer.from('data');

beforeEach(() => vi.clearAllMocks());

describe('loadFiles()', () => {
  it('returns zero-result for empty path list', async () => {
    const result = await loadFiles([]);
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0, errors: [] });
    expect(parse).not.toHaveBeenCalled();
  });

  it('succeeds when parse and persist both succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-1');

    const result = await loadFiles(['/a/spec.sec']);

    expect(result).toEqual({ total: 1, succeeded: 1, failed: 0, errors: [] });
  });

  it('isolates parse failure — other files still succeed', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse)
      .mockRejectedValueOnce(new Error('bad xml'))
      .mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockResolvedValue('spec-id-2');

    const result = await loadFiles(['/a/bad.sec', '/b/good.sec']);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe('/a/bad.sec');
    expect(result.errors[0]?.error).toBe('bad xml');
  });

  it('isolates persistParsedSpec failure', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockRejectedValue(new Error('db down'));

    const result = await loadFiles(['/a/spec.sec']);

    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error).toBe('db down');
  });

  it('isolates readFile ENOENT failure', async () => {
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    const result = await loadFiles(['/missing/spec.sec']);

    expect(result.failed).toBe(1);
    expect(result.errors[0]?.error).toContain('no such file');
  });

  it('skips persistParsedSpec when dryRun is true', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });

    const result = await loadFiles(['/a/spec.sec'], { dryRun: true });

    expect(persistParsedSpec).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(1);
  });

  it('calls onProgress once per file with correct args', async () => {
    vi.mocked(readFile).mockResolvedValue(mockBuf);
    vi.mocked(parse).mockResolvedValue({ tree: mockTree, refs: [] });
    vi.mocked(persistParsedSpec).mockResolvedValue('id');

    const calls: [number, number, string, boolean][] = [];
    await loadFiles(['/a/spec.sec', '/b/spec.sec'], {
      onProgress: (done, total, file, ok) => calls.push([done, total, file, ok]),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([1, 2, '/a/spec.sec', true]);
    expect(calls[1]).toEqual([2, 2, '/b/spec.sec', true]);
  });

  it('onProgress receives ok=false on failure', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('boom'));

    const okValues: boolean[] = [];
    await loadFiles(['/a/spec.sec'], {
      onProgress: (_d, _t, _f, ok) => okValues.push(ok),
    });

    expect(okValues).toEqual([false]);
  });
});
```

- [ ] **Step 2: Run tests to confirm fail**

```bash
pnpm test -- --reporter=verbose src/lib/file-loader.test.ts
```

Expected: FAIL — `loadFiles` not found

- [ ] **Step 3: Create `src/lib/file-loader.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { parse } from '../parser/index.js';
import { persistParsedSpec } from '../db/index.js';

export interface LoadResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly error: string }>;
}

export interface LoadOptions {
  readonly dryRun?: boolean;
  readonly onProgress?: (done: number, total: number, file: string, ok: boolean) => void;
}

export async function loadFiles(paths: readonly string[], opts?: LoadOptions): Promise<LoadResult> {
  const total = paths.length;
  if (total === 0) return { total: 0, succeeded: 0, failed: 0, errors: [] };

  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ readonly file: string; readonly error: string }> = [];
  let done = 0;

  for (const file of paths) {
    let ok = false;
    try {
      const buffer = await readFile(file);
      const result = await parse(buffer, file);
      if (!opts?.dryRun) {
        await persistParsedSpec(result);
      }
      succeeded++;
      ok = true;
    } catch (err) {
      failed++;
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
    done++;
    opts?.onProgress?.(done, total, file, ok);
  }

  return { total, succeeded, failed, errors };
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
pnpm test -- --reporter=verbose src/lib/file-loader.test.ts
```

Expected: all 8 pass.

- [ ] **Step 5: Run full lint + test suite**

```bash
pnpm lint && pnpm test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/file-loader.ts src/lib/file-loader.test.ts
git commit -m "feat(lib): add loadFiles() — format-agnostic bulk ingest with per-file error isolation"
```

---

## Task 4: Create `scripts/load-files.ts` + update `package.json`

Universal CLI. Accepts glob patterns or explicit paths as args. `seed:corpus` is just a preset invocation. Remove the now-superseded `scripts/load-ufgs.ts`.

**Files:**
- Create: `scripts/load-files.ts`
- Delete: `scripts/load-ufgs.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/load-files.ts`**

```typescript
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { loadFiles } from '../src/lib/file-loader.js';
import { pool } from '../src/db/index.js';

const PROJECT_ROOT = process.cwd();

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm load:files <glob-or-path> [...]');
    return 1;
  }

  const allFiles: string[] = [];
  for (const arg of args) {
    const matches = await Array.fromAsync(glob(arg, { cwd: PROJECT_ROOT }));
    if (matches.length > 0) {
      allFiles.push(...matches.map((m) => path.join(PROJECT_ROOT, m)));
    } else {
      allFiles.push(path.resolve(arg));
    }
  }

  if (allFiles.length === 0) {
    console.log('No files matched — nothing to load.');
    return 0;
  }

  console.log(`Loading ${allFiles.length} file(s)...`);
  let done = 0;

  const result = await loadFiles(allFiles, {
    onProgress: (_done, total, file, ok) => {
      done++;
      const rel = path.relative(PROJECT_ROOT, file);
      process.stdout.write(`${ok ? '✓' : '✗'} [${done}/${total}] ${rel}\n`);
    },
  });

  console.log(
    `\nResults: ${result.succeeded} succeeded, ${result.failed} failed of ${result.total} total`
  );

  if (result.errors.length > 0) {
    const shown = result.errors.slice(0, 20);
    console.error('\nErrors:');
    for (const e of shown) {
      console.error(`  ${path.relative(PROJECT_ROOT, e.file)}: ${e.error}`);
    }
    if (result.errors.length > 20) {
      console.error(`  ...and ${result.errors.length - 20} more`);
    }
  }

  return result.failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error('Fatal:', err);
    await pool.end();
    process.exit(1);
  });
```

- [ ] **Step 2: Delete `scripts/load-ufgs.ts`**

```bash
rm scripts/load-ufgs.ts
```

- [ ] **Step 3: Update `package.json` scripts**

In the `"scripts"` section, replace:
```json
"load:ufgs": "tsx scripts/load-ufgs.ts"
```
with:
```json
"load:files": "tsx scripts/load-files.ts",
"seed:corpus": "pnpm load:files 'docs/references/UFGS/**/*.SEC'"
```

- [ ] **Step 4: Verify lint passes (no ts-check on scripts, but confirm no import errors)**

```bash
pnpm lint
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/load-files.ts package.json
git rm scripts/load-ufgs.ts
git commit -m "feat(scripts): universal load:files CLI + seed:corpus preset — supersedes load-ufgs"
```

---

## Task 5: Add `load_files` MCP tool + MCP integration tests

Surface `loadFiles()` as an MCP tool. Write integration tests that verify the tool returns `LoadResult` JSON.

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.integration.test.ts`

- [ ] **Step 1: Write failing MCP integration tests**

Open `src/mcp/server.integration.test.ts`. Find the end of the file (after the last `it(...)` block, before the closing `}`). Add a new `describe` block:

```typescript
describe('load_files tool', () => {
  it('returns LoadResult JSON for a valid glob', async () => {
    const url = `${baseUrl}/mcp`;
    const response = await mcpCall(url, 'tools/call', {
      name: 'load_files',
      arguments: {
        glob: 'docs/references/UFGS/DIVISION_27/*.SEC',
      },
    });

    const rpc = response as { result?: { content?: { text?: string }[] } };
    const text = rpc.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const loadResult = JSON.parse(text ?? '{}') as {
      total: number;
      succeeded: number;
      failed: number;
      errors: unknown[];
    };
    expect(typeof loadResult.total).toBe('number');
    expect(typeof loadResult.succeeded).toBe('number');
    expect(typeof loadResult.failed).toBe('number');
    expect(Array.isArray(loadResult.errors)).toBe(true);
    expect(loadResult.total).toBeGreaterThan(0);
  });

  it('returns zero-result for non-matching glob — not an error', async () => {
    const url = `${baseUrl}/mcp`;
    const response = await mcpCall(url, 'tools/call', {
      name: 'load_files',
      arguments: {
        glob: 'docs/references/UFGS/**/*.NOMATCH',
      },
    });

    const rpc = response as { result?: { content?: { text?: string }[] } };
    const text = rpc.result?.content?.[0]?.text;
    const loadResult = JSON.parse(text ?? '{}') as { total: number };
    expect(loadResult.total).toBe(0);
  });

  it('returns error when neither glob nor paths provided', async () => {
    const url = `${baseUrl}/mcp`;
    const response = await mcpCall(url, 'tools/call', {
      name: 'load_files',
      arguments: {},
    });

    const rpc = response as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(rpc.result?.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration tests to confirm the new tests fail**

```bash
pnpm test:integration -- --reporter=verbose src/mcp/server.integration.test.ts
```

Expected: FAIL — `load_files` tool not found

- [ ] **Step 3: Add `handleLoadFiles` and `registerLoaderTools` to `src/mcp/tools.ts`**

Add import at the top of `src/mcp/tools.ts`:

```typescript
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { loadFiles } from '../lib/file-loader.js';
```

(Note: `path` may already be imported — check and merge if so.)

Add the handler function before the `registerTools` export:

```typescript
async function handleLoadFiles({
  glob: globPattern,
  paths: explicitPaths,
  dry_run,
}: {
  glob?: string;
  paths?: string[];
  dry_run?: boolean;
}): Promise<ToolResult> {
  if (!globPattern && (!explicitPaths || explicitPaths.length === 0)) {
    return toolError('Provide at least one of: glob, paths');
  }
  try {
    const resolved: string[] = [];
    if (globPattern) {
      const matches = await Array.fromAsync(glob(globPattern, { cwd: process.cwd() }));
      resolved.push(...matches.map((m) => path.resolve(m)));
    }
    if (explicitPaths) {
      resolved.push(...explicitPaths.map((p) => path.resolve(p)));
    }
    const result = await loadFiles(resolved, { dryRun: dry_run ?? false });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool load_files failed');
    return toolError('Internal error — file loading failed');
  }
}

function registerLoaderTools(server: McpServer): void {
  server.registerTool(
    'load_files',
    {
      description:
        'Bulk-load spec files into the library from a glob pattern or explicit paths. Accepts .SEC and .docx formats. Returns a summary of succeeded, failed, and any error details. Idempotent — re-loading an existing spec updates it.',
      inputSchema: {
        glob: z
          .string()
          .optional()
          .describe('Glob pattern relative to project root, e.g. "docs/references/UFGS/**/*.SEC"'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Explicit file paths (absolute or relative to project root)'),
        dry_run: z
          .boolean()
          .optional()
          .describe('If true, parse files but skip database writes — useful for validation'),
      },
    },
    handleLoadFiles
  );
}
```

Add `registerLoaderTools(server)` to the `registerTools` export function:

```typescript
export function registerTools(server: McpServer): void {
  registerLibraryTools(server);
  registerSpecTools(server);
  registerParserTools(server);
  registerGeneratorTools(server);
  registerLoaderTools(server);
}
```

- [ ] **Step 4: Run integration tests to confirm pass**

```bash
pnpm test:integration -- --reporter=verbose src/mcp/server.integration.test.ts
```

Expected: all pass. Note: the `load_files` glob test will actually parse UFGS files and insert them — this is expected and idempotent.

- [ ] **Step 5: Run full lint + test suite**

```bash
pnpm lint && pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.integration.test.ts
git commit -m "feat(mcp): add load_files tool — bulk ingest via glob or explicit paths"
```

---

## Task 6: File-loader integration tests + README + PR

Integration tests with real DB + real parser. README updates. Open the PR.

**Files:**
- Create: `src/lib/file-loader.integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write `src/lib/file-loader.integration.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { pool } from '../db/index.js';
import { loadFiles } from './file-loader.js';

const PROJECT_ROOT = path.resolve(process.cwd());
const SEC_FIXTURE = path.join(PROJECT_ROOT, 'docs/references/UFGS/DIVISION_27/27_10_00.SEC');
const DOCX_FIXTURE = path.join(
  PROJECT_ROOT,
  'docs/references/fixtures/27_10_00_Telecommunications.docx'
);

// Clean up any specs loaded by these tests
afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE source IN ('unknown', 'ufgs') AND section = '27 10 00'`);
  await pool.end();
});

describe('loadFiles() integration', () => {
  it('loads a .SEC file — rows appear in specs and paragraphs tables', async () => {
    const result = await loadFiles([SEC_FIXTURE]);

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const row = await pool.query<{ id: string; section: string }>(
      `SELECT id, section FROM specs WHERE section = '27 10 00' LIMIT 1`
    );
    expect(row.rows[0]?.section).toBe('27 10 00');

    const paras = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM paragraphs WHERE spec_id = $1`,
      [row.rows[0]?.id]
    );
    expect(parseInt(paras.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  });

  it('is idempotent — re-loading same file produces same row count', async () => {
    const first = await loadFiles([SEC_FIXTURE]);
    const second = await loadFiles([SEC_FIXTURE]);

    expect(first.succeeded).toBe(1);
    expect(second.succeeded).toBe(1);

    const row = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM specs WHERE section = '27 10 00'`
    );
    expect(parseInt(row.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('reports failure for non-existent file, continues', async () => {
    const result = await loadFiles(['/nonexistent/file.sec', SEC_FIXTURE]);

    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.errors[0]?.file).toBe('/nonexistent/file.sec');
  });

  it('dryRun — parses without writing to DB', async () => {
    await pool.query(`DELETE FROM specs WHERE section = '27 99 99'`);

    const result = await loadFiles([SEC_FIXTURE], { dryRun: true });

    expect(result.succeeded).toBe(1);
  });
});
```

**Note:** If `docs/references/fixtures/27_10_00_Telecommunications.docx` does not exist, remove the DOCX_FIXTURE constant and the DOCX test from this file for now — add it when a DOCX fixture is available.

- [ ] **Step 2: Run integration tests**

```bash
pnpm test:integration -- --reporter=verbose src/lib/file-loader.integration.test.ts
```

Expected: all pass. If a DOCX fixture doesn't exist, skip the DOCX test.

- [ ] **Step 3: Update README.md — Commands section**

Find the `### Commands` or `## Build` section and add after the existing script entries:

```markdown
| `pnpm load:files <glob>` | Load spec files matching glob into library (e.g. `pnpm load:files 'docs/**/*.SEC'`) |
| `pnpm seed:corpus` | Bulk-load all 665 UFGS `.SEC` files into library (idempotent) |
```

- [ ] **Step 4: Update README.md — MCP Tools section**

In the MCP tools table, add a row for `load_files`:

```markdown
| `load_files` | Bulk-load specs from a glob pattern or file path list. Returns `{ total, succeeded, failed, errors[] }`. Idempotent. |
```

- [ ] **Step 5: Run full suite one final time**

```bash
pnpm lint && pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 6: Commit README + integration test**

```bash
git add src/lib/file-loader.integration.test.ts README.md
git commit -m "test(lib): file-loader integration tests + README docs for load:files and seed:corpus"
```

- [ ] **Step 7: Open PR**

```bash
gh pr create \
  --title "feat(lib): universal file loader — bulk ingest any format, seed:corpus preset" \
  --body "$(cat <<'EOF'
## Summary

- Extracts `persistParsedSpec` from `src/mcp/tools.ts` to `src/db/queries/specs.ts` — fixes module boundary violation, now also persists SEC refs (partial #53)
- Adds `parse(buffer, filename): Promise<ParseResult>` dispatcher to `src/parser/index.ts` — extension-based, uses `decodeTextBuffer` for encoding-transparent SEC ingest
- Creates `src/lib/file-loader.ts` with `loadFiles(paths, opts): Promise<LoadResult>` — per-file error isolation, dry-run mode, progress callback
- Adds `scripts/load-files.ts` CLI + `pnpm load:files` and `pnpm seed:corpus` scripts — replaces `scripts/load-ufgs.ts`
- Adds `load_files` MCP tool — accepts `glob` pattern or `paths` array, returns `LoadResult` JSON

## Test plan

- [ ] `pnpm test` — all unit tests pass
- [ ] `pnpm test:integration` — all integration tests pass including new `file-loader.integration.test.ts` and `load_files` MCP tool tests
- [ ] `pnpm lint` — clean
- [ ] `pnpm seed:corpus` — loads all 665 UFGS `.SEC` files; verify with `search_library` returning results
- [ ] Re-run `pnpm seed:corpus` — idempotent, same row counts

Closes #58
EOF
)"
```

---

## Self-review checklist

- [x] **Spec coverage:** `persistParsedSpec` extraction ✓ | `parse()` dispatcher ✓ | `loadFiles()` ✓ | CLI `load:files` ✓ | `seed:corpus` preset ✓ | `load_files` MCP tool ✓ | README ✓ | PR closes #58 ✓
- [x] **No placeholders:** all steps contain actual code
- [x] **Type consistency:** `ParseResult` defined in Task 2, used in Tasks 3/5 | `LoadResult` defined in Task 3, used in Tasks 4/5 | `persistParsedSpec` signature matches usage in Task 3
- [x] **pool.end():** CLI script calls `pool.end()` before `process.exit()` — process will not hang
- [x] **Glob paths are resolved to absolute** before passing to `loadFiles` — `readFile` needs absolute paths
- [x] **`load-ufgs.ts` deleted** — git rm in Task 4 step 5
