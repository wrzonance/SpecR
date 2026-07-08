# Logging & Parse-Observability Hardening (P0+P1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every parse a durable, per-document, warning-visible, field-queryable JSONL log, and a machine-branchable error taxonomy — so a human or an autonomous loop can diagnose failures across a large malformed corpus.

**Architecture:** All wiring lands at the **main-thread boundary** (`api/parse.ts`, `api/onboarding.ts`, `mcp/parse-document-handler.ts`, `lib/file-loader.ts`) plus `lib/logger.ts`, `lib/errors.ts`, and the parser's typed-error/`ParseWarning` data. The parser and the Piscina worker are **not** given logging; degradations become `ParseWarning` data on the tree that the boundary logs. No Postgres involvement (ADR-056).

**Tech Stack:** TypeScript/Node 22 ESM, pino v10, `pino-roll` (new), Zod v4, vitest.

**Design of record:** `docs/adr/056-logging-observability-hardening.md`. Tracking issue: **#422**.

## Global Constraints

- ESM project: relative imports end in `.js`; type-only imports use `import type` (`verbatimModuleSyntax`).
- No `console.*` in `src/` — use the pino `logger`. No `any`, no `as unknown as`, no non-null `!` outside tests.
- File cap **400 lines**; function cap **50 lines**; `complexity` ≤ 10; `sonarjs/cognitive-complexity` ≤ 10.
- Typed errors extend `SpecrError`; chain `cause` at boundaries. Validate external input with Zod; use `z.uuid()` not `z.string().uuid()`.
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on — guard optionals; assign optional class fields conditionally.
- New dependency `pino-roll` must be **MIT/permissive, from the pino-org publisher, and lockfile-pinned** (`security.md`). Run `pnpm audit` after adding.
- If a response/tool shape changes, update `openapi.yaml` in **this PR** (contract gate + ADR-044/026).
- Commit scope = module changed (e.g. `feat(logging): …`). Co-author trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Commands: unit `pnpm test`; lint `pnpm lint`; build `pnpm build`; integration (needs PG) `pnpm test:integration`.

---

### Task 1: `pino-roll` dependency + env config + logger file sink

**Files:**
- Modify: `package.json` (add `pino-roll`), `pnpm-lock.yaml` (via `pnpm add`)
- Modify: `src/lib/env.ts:3-47` (add `LOG_DIR`, `LOG_TO_FILE`)
- Modify: `src/lib/logger.ts` (whole file)
- Modify: `.gitignore` (add `logs/`)
- Create: `src/lib/logger.test.ts`

**Interfaces:**
- Produces: `buildLoggerOptions(cfg: Config): pino.LoggerOptions` (exported from `logger.ts`); `logger` (unchanged import used everywhere).

- [ ] **Step 1: Vet + add the dependency**

Run: `pnpm add pino-roll && pnpm audit`
Confirm before continuing: `pino-roll` license is MIT and publisher is the pino org; it now appears in `pnpm-lock.yaml`. If the audit flags an advisory, stop and report.

- [ ] **Step 2: Add env config (write the failing test first)**

Add to `src/lib/logger.test.ts` (create if absent — keep the options test beside `logger.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { buildLoggerOptions } from './logger.js';

const base = {
  NODE_ENV: 'production' as const, LOG_LEVEL: 'info', LOG_DIR: 'logs', LOG_TO_FILE: false,
};

describe('buildLoggerOptions', () => {
  it('prod, no file → plain pino (no transport worker), unchanged behaviour', () => {
    const opts = buildLoggerOptions({ ...base } as never);
    expect(opts.transport).toBeUndefined();
    expect(opts.level).toBe('info');
  });
  it('dev → pino-pretty transport target', () => {
    const opts = buildLoggerOptions({ ...base, NODE_ENV: 'development' } as never);
    const targets = (opts.transport as { targets: Array<{ target: string }> }).targets;
    expect(targets.some((t) => t.target === 'pino-pretty')).toBe(true);
  });
  it('LOG_TO_FILE → pino-roll file target + stdout in prod', () => {
    const opts = buildLoggerOptions({ ...base, LOG_TO_FILE: true } as never);
    const targets = (opts.transport as { targets: Array<{ target: string; options: Record<string, unknown> }> }).targets;
    expect(targets.some((t) => t.target === 'pino-roll')).toBe(true);
    expect(targets.some((t) => t.target === 'pino/file')).toBe(true); // stdout mirror
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- logger.test`
Expected: FAIL — `buildLoggerOptions` is not exported.

- [ ] **Step 4: Add env vars**

In `src/lib/env.ts`, add to the `z.object({…})` (after `LOG_LEVEL`, line 7):

```ts
  LOG_DIR: z.string().default('logs'),
  // When true, tee logs to a rotating JSONL file under LOG_DIR (pino-roll). Off by
  // default so tests/CI stay stdout-only; the corpus runner sets it true.
  LOG_TO_FILE: z.stringbool().default(false),
```

- [ ] **Step 5: Rewrite the logger with a testable options builder**

Replace all of `src/lib/logger.ts` with:

```ts
import pino from 'pino';
import { join } from 'node:path';
import { config } from './env.js';
import type { Config } from './env.js';

type Target = { target: string; level: string; options: Record<string, unknown> };

// Pure so it is unit-testable without spinning a transport worker. Behaviour:
//  - prod/test, no file → plain JSON to stdout (no transport; unchanged from before)
//  - development       → pino-pretty
//  - LOG_TO_FILE       → rotating JSONL file (pino-roll), plus a stdout mirror in prod
export function buildLoggerOptions(cfg: Config): pino.LoggerOptions {
  const targets: Target[] = [];
  if (cfg.NODE_ENV === 'development') {
    targets.push({ target: 'pino-pretty', level: cfg.LOG_LEVEL, options: {} });
  }
  if (cfg.LOG_TO_FILE) {
    if (cfg.NODE_ENV !== 'development') {
      targets.push({ target: 'pino/file', level: cfg.LOG_LEVEL, options: { destination: 1 } });
    }
    targets.push({
      target: 'pino-roll',
      level: cfg.LOG_LEVEL,
      options: {
        file: join(cfg.LOG_DIR, 'specr'),
        frequency: 'daily',
        size: '20m',
        extension: '.jsonl',
        mkdir: true,
      },
    });
  }
  return targets.length === 0
    ? { level: cfg.LOG_LEVEL }
    : { level: cfg.LOG_LEVEL, transport: { targets } };
}

export const logger = pino(buildLoggerOptions(config));
```

- [ ] **Step 6: gitignore the logs dir**

Append `logs/` to `.gitignore`.

- [ ] **Step 7: Run tests + lint + build**

Run: `pnpm test -- logger.test && pnpm lint && pnpm build`
Expected: PASS; no lint/type errors.

- [ ] **Step 8: Manual smoke**

Run: `LOG_TO_FILE=true pnpm start` briefly (or a tsx one-liner importing `logger` and calling `logger.info('smoke')`), confirm `logs/specr.<date>.jsonl` appears with one JSON object per line, then stop.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/env.ts src/lib/logger.ts src/lib/logger.test.ts .gitignore
git commit -m "feat(logging): JSONL file sink to logs/ via pino-roll, env-gated

Refs #422

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Per-document child logger helper

**Files:**
- Create: `src/lib/log-context.ts`, `src/lib/log-context.test.ts`

**Interfaces:**
- Consumes: `logger` from `./logger.js`.
- Produces: `interface ParseLogFields { filename; sha256; loader; specId?; jobId? }`; `parseLog(fields: ParseLogFields): Logger`.

- [ ] **Step 1: Write the failing test**

`src/lib/log-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLog } from './log-context.js';

describe('parseLog', () => {
  it('binds document context under an app-controlled `doc` key', () => {
    const child = parseLog({ filename: 'a.docx', sha256: 'deadbeef', loader: 'load_files' });
    const b = child.bindings() as { doc?: { sha256?: string; filename?: string } };
    expect(b.doc?.sha256).toBe('deadbeef');
    expect(b.doc?.filename).toBe('a.docx');
  });
  it('includes specId when provided', () => {
    const child = parseLog({ filename: 'a.docx', sha256: 'x', loader: 'rest:parse', specId: 's1' });
    expect((child.bindings() as { doc?: { specId?: string } }).doc?.specId).toBe('s1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- log-context.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/log-context.ts`:

```ts
import { logger } from './logger.js';
import type { Logger } from 'pino';

export interface ParseLogFields {
  readonly filename: string;
  readonly sha256: string;
  readonly loader: string;
  readonly specId?: string;
  readonly jobId?: string;
}

// Per-document child logger. Untrusted values (filename) are namespaced under an
// app-controlled `doc` key so they can never overwrite reserved pino fields.
export function parseLog(fields: ParseLogFields): Logger {
  return logger.child({ doc: { ...fields } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- log-context.test && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/log-context.ts src/lib/log-context.test.ts
git commit -m "feat(logging): per-document child logger helper (parseLog)

Refs #422

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Surface `SpecTree.warnings` on every path (+ log them, + openapi)

**Files:**
- Modify: `src/lib/file-loader.ts` (`LoadResult`, `processFile`, `loadFiles`)
- Modify: `src/mcp/parse-document-handler.ts` (`handleParseDocument` response + log)
- Modify: `src/api/parse.ts:243-249` and `src/api/onboarding.ts:260-268` (log warnings; child logger on the error line)
- Modify: `openapi.yaml` (document the `warnings` field on the `/parse` job result and the `parse_document` response)
- Create/modify tests: `src/lib/file-loader.test.ts`, `src/mcp/parse-document-handler.test.ts`

**Interfaces:**
- Consumes: `parseLog` (Task 2); `ParseWarning` from `../ast/types.js`.
- Produces: `interface FileParseWarnings { file: string; warnings: readonly ParseWarning[] }`; `LoadResult.parseWarnings: ReadonlyArray<FileParseWarnings>`; pure `fileParseWarnings(file, tree): FileParseWarnings | null`.

- [ ] **Step 1: Write the failing pure-helper test (load path)**

Add to `src/lib/file-loader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileParseWarnings } from './file-loader.js';
import type { SpecTree } from '../ast/types.js';

const tree = (warnings?: SpecTree['warnings']): SpecTree =>
  ({ id: 'r', section: '09 91 23', title: 'x', parts: [], ...(warnings ? { warnings } : {}) });

describe('fileParseWarnings', () => {
  it('returns null when the tree has no warnings', () => {
    expect(fileParseWarnings('a.docx', tree())).toBeNull();
  });
  it('returns file-scoped warnings when present', () => {
    const w = [{ type: 'unusual-part-count' as const, suggestion: 's' }];
    expect(fileParseWarnings('a.docx', tree(w))).toEqual({ file: 'a.docx', warnings: w });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- file-loader.test`
Expected: FAIL — `fileParseWarnings` not exported.

- [ ] **Step 3: Implement the load-path changes**

In `src/lib/file-loader.ts`:

Add the import and types near the top:

```ts
import type { ParseWarning } from '../ast/types.js';
import { parseLog } from './log-context.js';
```

```ts
export interface FileParseWarnings {
  readonly file: string;
  readonly warnings: readonly ParseWarning[];
}

export function fileParseWarnings(file: string, tree: { warnings?: readonly ParseWarning[] }): FileParseWarnings | null {
  const warnings = tree.warnings ?? [];
  return warnings.length > 0 ? { file, warnings } : null;
}
```

Extend `LoadResult` (line 23-29) with:

```ts
  readonly parseWarnings: ReadonlyArray<FileParseWarnings>;
```

Change `processFile` (line 79-95) to accept and populate a `parseWarnings` array and log per file:

```ts
async function processFile(
  file: string,
  dryRun: boolean,
  inferenceWarnings: InferenceWarning[],
  parseWarnings: FileParseWarnings[]
): Promise<void> {
  const buffer = await readFile(file);
  const sha256 = sha256Hex(buffer); // hoisted so pre-persist failures stay attributable
  const log = parseLog({ filename: path.basename(file), sha256, loader: 'load_files' });
  const result = await parse(buffer, file);
  const fw = fileParseWarnings(file, result.tree);
  if (fw) log.warn({ warnings: fw.warnings }, 'parse produced warnings');
  // Collect before the dry-run return so a preview still reports warnings (#422).
  if (fw) parseWarnings.push(fw);
  if (dryRun) return;
  const originMeta: OriginMeta = { filename: path.basename(file), sha256, loader: 'load_files' };
  const specId = await persistParsedSpec({ ...result, originMeta });
  const warning = await buildInferenceWarning(file, specId, result.sectionInference);
  if (warning) inferenceWarnings.push(warning);
}
```

In `loadFiles` (line 97-122): add `const parseWarnings: FileParseWarnings[] = [];`, pass it to `processFile`, include `parseWarnings` in **both** returns (the empty-`total` early return at line 99 and the final return at 121). Empty-return value: `parseWarnings: []`.

- [ ] **Step 4: Run helper test + confirm build**

Run: `pnpm test -- file-loader.test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Write the failing MCP test**

Add to `src/mcp/parse-document-handler.test.ts` a test that the response includes `warnings` when the tree has them. If the handler's parse is hard to stub without DB, extract a pure builder and test it:

Add to `parse-document-handler.ts`:

```ts
export function buildParseResponse(
  specId: string, tree: SpecTree, sectionInference: SectionInference, nodeCount: number
): Record<string, unknown> {
  const response: Record<string, unknown> = { specId, section: tree.section, title: tree.title, nodeCount };
  if (tree.warnings && tree.warnings.length > 0) response['warnings'] = tree.warnings;
  if (sectionInference.method !== 'metadata') {
    response['sectionInference'] = { ...sectionInference, note: INFERENCE_NOTE };
  }
  return response;
}
```

(Hoist the existing inline note string to a module const `INFERENCE_NOTE`.) Test:

```ts
import { describe, it, expect } from 'vitest';
import { buildParseResponse } from './parse-document-handler.js';

describe('buildParseResponse', () => {
  it('includes warnings when the tree carries them', () => {
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [], warnings: [{ type: 'unusual-part-count' as const }] };
    const r = buildParseResponse('s1', tree, { method: 'metadata', confidence: 'high', inferredSection: '', inferredTitle: '', titleMatch: 'unknown' }, 3);
    expect(r['warnings']).toHaveLength(1);
    expect(r['sectionInference']).toBeUndefined();
  });
});
```

- [ ] **Step 6: Wire the MCP handler to the builder + log**

In `handleParseDocument` (line 145-157), replace the inline `response` construction with `const response = buildParseResponse(specId, enriched.tree, enriched.sectionInference, nodeCount);` and, before returning, emit warnings on a child logger:

```ts
    const log = parseLog({ filename: sanitizeFilename(filename), sha256: originMeta.sha256, loader: originMeta.loader, specId });
    if (enriched.tree.warnings?.length) log.warn({ warnings: enriched.tree.warnings }, 'parse produced warnings');
```

(Import `parseLog` from `../lib/log-context.js`.)

- [ ] **Step 7: Log warnings on the REST + onboarding paths**

In `src/api/parse.ts` (the job processor holding `finalTree`, `filename`, `buffer`, `jobId`): after building the origin meta / before/after `updateJob(...complete)`, add:

```ts
    const log = parseLog({ filename, sha256: buildOriginMeta(filename, buffer).sha256, loader: 'rest:parse', jobId, specId });
    if (finalTree.warnings?.length) log.warn({ warnings: finalTree.warnings }, 'parse produced warnings');
```

and change the catch line (`parse.ts:244`) to use a `jobId`-bound child logger. In `src/api/onboarding.ts` (`processOnboardingJob`, holding `tree`, `filename`, `jobId`, `specId`): after building the report (line 249), add the same guarded `log.warn({ warnings: tree.warnings }, …)`. (Import `parseLog`.) Avoid recomputing the hash twice — reuse the already-computed origin meta where available.

- [ ] **Step 8: Update `openapi.yaml`**

Add the `warnings` array (items: `{ type: string, lineHint?: string, suggestion?: string }`) to the documented `/parse` job-result schema **and** the `parse_document` tool response. First `grep -n "warnings" openapi.yaml` — if `/parse` already returns `warnings` in code but the spec omits it, this also fixes latent drift (keep openapi accurate).

- [ ] **Step 9: Run everything**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: PASS. Then `pnpm test:integration` (if PG available) — the contract/openapi gate (`src/api/contract.integration.test.ts`) and MCP contract test must stay green.

- [ ] **Step 10: Commit**

```bash
git add src/lib/file-loader.ts src/lib/file-loader.test.ts src/mcp/parse-document-handler.ts src/mcp/parse-document-handler.test.ts src/api/parse.ts src/api/onboarding.ts openapi.yaml
git commit -m "feat(logging): surface parse warnings on MCP/load/REST/onboarding paths

Refs #422

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `SpecrError` code taxonomy + thread into parser throw sites (P1)

**Files:**
- Modify: `src/lib/errors.ts`, `src/parser/error.ts`
- Modify (thread codes): `src/parser/docx/index.ts`, `src/parser/docx/numbering.ts`, `src/parser/docx/styles.ts`, `src/parser/docx/document.ts`, `src/parser/sec/index.ts`, `src/parser/pdf/extract.ts`, `src/parser/index.ts`
- Create: `src/lib/errors.test.ts`, add to `src/parser/docx/index.test.ts` (or `src/parser/index.test.ts`)

**Interfaces:**
- Produces: `SpecrError` gains `readonly code?: string`; `ParserError` gains `readonly code?: ParserErrorCode`; `type ParserErrorCode = 'DOCX_ARCHIVE_UNREADABLE' | 'DOCX_MISSING_DOCUMENT' | 'DOCX_NO_PARAGRAPHS' | 'NUMBERING_XML_INVALID' | 'STYLES_XML_INVALID' | 'SEC_XML_INVALID' | 'PDF_TEXT_LAYER_UNEXTRACTABLE' | 'UNSUPPORTED_FORMAT'`.

- [ ] **Step 1: Write the failing test**

`src/lib/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SpecrError } from './errors.js';
import { ParserError } from '../parser/error.js';

describe('error codes', () => {
  it('SpecrError carries an optional machine-branchable code', () => {
    const e = new SpecrError('boom', { code: 'X' });
    expect(e.code).toBe('X');
    expect(e.name).toBe('SpecrError');
  });
  it('ParserError narrows code and chains cause', () => {
    const cause = new Error('root');
    const e = new ParserError('bad docx', { code: 'DOCX_NO_PARAGRAPHS', cause });
    expect(e.code).toBe('DOCX_NO_PARAGRAPHS');
    expect(e.cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- errors.test`
Expected: FAIL — `code` does not exist on `SpecrError`.

- [ ] **Step 3: Implement**

`src/lib/errors.ts`:

```ts
export interface SpecrErrorOptions extends ErrorOptions {
  readonly code?: string;
}

export class SpecrError extends Error {
  readonly code?: string;
  constructor(message: string, options?: SpecrErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
    if (options?.code !== undefined) this.code = options.code;
  }
}
```

`src/parser/error.ts`:

```ts
import { SpecrError } from '../lib/errors.js';
import type { SpecrErrorOptions } from '../lib/errors.js';

export type ParserErrorCode =
  | 'DOCX_ARCHIVE_UNREADABLE'
  | 'DOCX_MISSING_DOCUMENT'
  | 'DOCX_NO_PARAGRAPHS'
  | 'NUMBERING_XML_INVALID'
  | 'STYLES_XML_INVALID'
  | 'SEC_XML_INVALID'
  | 'PDF_TEXT_LAYER_UNEXTRACTABLE'
  | 'UNSUPPORTED_FORMAT';

export interface ParserErrorOptions extends SpecrErrorOptions {
  readonly code?: ParserErrorCode;
}

export class ParserError extends SpecrError {
  override readonly code?: ParserErrorCode;
  constructor(message: string, options?: ParserErrorOptions) {
    super(message, options);
    if (options?.code !== undefined) this.code = options.code;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- errors.test && pnpm build`
Expected: PASS.

- [ ] **Step 5: Thread codes into existing throw sites (one code each; message unchanged)**

For each `throw new ParserError('…', { cause })` add the matching `code`. Read each site and set: `docx/index.ts` archive-read failure → `DOCX_ARCHIVE_UNREADABLE`; missing `word/document.xml` → `DOCX_MISSING_DOCUMENT`; "document contains no paragraphs" → `DOCX_NO_PARAGRAPHS`; `numbering.ts` parse failure → `NUMBERING_XML_INVALID`; `styles.ts` → `STYLES_XML_INVALID`; `document.ts` → `DOCX_MISSING_DOCUMENT`; `sec/index.ts` → `SEC_XML_INVALID`; `pdf/extract.ts` unextractable → `PDF_TEXT_LAYER_UNEXTRACTABLE`; `parser/index.ts` unsupported ext → `UNSUPPORTED_FORMAT`. Example edit shape:

```ts
throw new ParserError('failed to read DOCX archive', { code: 'DOCX_ARCHIVE_UNREADABLE', cause: err });
```

- [ ] **Step 6: Write the failing integration-lite test for a real throw**

Add to `src/parser/docx/index.test.ts` (unit — no DB):

```ts
import { ParserError } from '../error.js';
import { parseDocx } from './index.js';

it('throws ParserError with DOCX_ARCHIVE_UNREADABLE on a non-zip buffer', async () => {
  await expect(parseDocx(Buffer.from('not a zip'), () => {})).rejects.toMatchObject({
    name: 'ParserError',
    code: 'DOCX_ARCHIVE_UNREADABLE',
  });
});
```

- [ ] **Step 7: Run to verify pass**

Run: `pnpm test -- errors.test docx/index.test && pnpm lint && pnpm build`
Expected: PASS. (pino's std `err` serializer emits `.code` automatically, so these codes now appear in every logged error — no logger change needed.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/errors.ts src/lib/errors.test.ts src/parser/error.ts src/parser/docx/ src/parser/sec/index.ts src/parser/pdf/extract.ts src/parser/index.ts src/parser/docx/index.test.ts
git commit -m "feat(parser): machine-branchable error code taxonomy on SpecrError/ParserError

Refs #422

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Corrupt `core.xml` → `core-metadata-unreadable` ParseWarning (P1)

**Files:**
- Modify: `src/ast/types.ts:134-145` (add union member) and `src/ast/schemas.ts:~242-247` (Zod mirror)
- Modify: `src/parser/docx/index.ts` (`parseCoreMetadata` returns a warning signal; `parseDocx` appends it to `tree.warnings`)
- Create/modify test: `src/parser/docx/index.test.ts`, plus a test helper to build a minimal `.docx`

**Interfaces:**
- Produces: `ParseWarningType` gains `'core-metadata-unreadable'`; `parseCoreMetadata` returns `{ section; title; warning?: ParseWarning }`.

- [ ] **Step 1: Add the warning type + Zod mirror**

`src/ast/types.ts` — add to the `ParseWarningType` union (after `'non-conforming-part-numbering'`):

```ts
  | 'core-metadata-unreadable'
```

`src/ast/schemas.ts` — add the same literal to the `ParseWarningTypeSchema` enum/union (grep `non-conforming-part-numbering` to find it). Keep the two in sync (a unit test compares them if one exists).

- [ ] **Step 2: Write the failing test**

Add a test helper `src/parser/docx/test-support.ts` (test-only) that zips a minimal valid `.docx` with JSZip given a `core.xml` string, then:

```ts
import { makeMinimalDocx } from './test-support.js';
import { parseDocx } from './index.js';

it('emits core-metadata-unreadable when docProps/core.xml is malformed', async () => {
  const buf = await makeMinimalDocx({ coreXml: '<<<not xml' }); // valid document.xml, broken core.xml
  const tree = await parseDocx(buf, () => {});
  expect(tree.warnings?.some((w) => w.type === 'core-metadata-unreadable')).toBe(true);
});
```

`makeMinimalDocx` must emit `[Content_Types].xml`, `word/document.xml` (one `w:p` with a `PART 1 - GENERAL`-ish run so parse succeeds), and `docProps/core.xml` (the passed string). Reuse any existing docx-building helper if one exists (`grep -rl "new JSZip" src`); otherwise add this one.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- docx/index.test`
Expected: FAIL — no `core-metadata-unreadable` warning is produced.

- [ ] **Step 4: Implement the signal**

In `src/parser/docx/index.ts`, change `parseCoreMetadata` (line 32-51) to return the warning on the catch:

```ts
function parseCoreMetadata(xml: string): { section: string; title: string; warning?: ParseWarning } {
  try {
    // …unchanged happy path…
    return { section, title };
  } catch (err) {
    return {
      section: 'unknown',
      title: 'unknown',
      warning: {
        type: 'core-metadata-unreadable',
        suggestion: 'docProps/core.xml could not be parsed; section/title fell back to content inference.',
      },
    };
  }
}
```

Then, where `parseDocx` assembles `tree.warnings` (near the `auditTreeStructure` attach, `docx/index.ts:~134`): read that region, capture the `warning` returned by `parseCoreMetadata`, and include it in the warnings array passed onto the tree (dedupe not needed — it fires at most once). Import `ParseWarning` type via `import type { ParseWarning } from '../../ast/types.js'`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- docx/index.test && pnpm lint && pnpm build`
Expected: PASS. Because Task 3 surfaces `tree.warnings`, this now also logs on every path — no extra wiring.

- [ ] **Step 6: Commit**

```bash
git add src/ast/types.ts src/ast/schemas.ts src/parser/docx/index.ts src/parser/docx/index.test.ts src/parser/docx/test-support.ts
git commit -m "feat(parser): emit core-metadata-unreadable warning instead of silent 'unknown'

Refs #422

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before opening the PR)

- [ ] `pnpm lint && pnpm build && pnpm test` all green.
- [ ] With PG: `pnpm migrate && pnpm seed && pnpm test:integration` green — contract/openapi + MCP contract gates pass.
- [ ] Manual: run a malformed fixture through `load:files` with `LOG_TO_FILE=true`; confirm `logs/specr.<date>.jsonl` contains per-document lines bound with `doc.sha256`, a `warn` line carrying `warnings`, and (for a corrupt file) an error line carrying `err.code`.
- [ ] Open a **draft** PR: title `feat(logging): parse-observability hardening (P0+P1)`, body = why/what + testing checkboxes, `Closes #422`, credit Claude Opus 4.8. Drive CI + CodeRabbit to green; move #422 → In review.

## Self-review notes

- **Spec coverage:** ADR-056 Decision 1→Task 1; 2→Tasks 2+3; 3→Task 3; 4→Task 4; 5→Task 5. Invariants 1-3→Task 3; Invariant 3 (code serialization)→Task 4; Invariant 4→Task 5; Invariant 5→Task 1; Invariant 6→Task 3 Step 9.
- **Deferred to P2 (not this plan):** `parse-diagnostics.jsonl`, `inferSectionMeta`/PDF swallow conversions, request-id middleware, redaction.
- **Type consistency:** `fileParseWarnings`, `FileParseWarnings`, `LoadResult.parseWarnings`, `buildParseResponse`, `ParseLogFields`, `parseLog`, `ParserErrorCode` are used with identical names/signatures across tasks.
