# Library Import Onboarding (O-8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /libraries/:id/import` — an async multipart endpoint that parses a master document into a target ADR-015 library, derives a style template (DOCX), classifies editability, and returns a three-section onboarding report.

**Architecture:** Pure orchestration over already-tested building blocks. The endpoint mirrors `POST /parse`: validate + harden the upload, create an in-memory job (`lib/jobs.ts`), return `202 {jobId}`, and run the pipeline off-thread. The pipeline reuses `parsePool` (parse + source-fact capture), `persistParsedSpec` (extended with explicit `libraryId`), `analyzeDocxStyles`/`deriveTemplate`/`createTemplateWithRules`/`setSpecStyleSource` (DOCX style), and `reclassifySpec` (editability against the library's convention profile or built-in default). The job result is the onboarding report; source bytes are discarded after parse (ADR-021).

**Tech Stack:** TypeScript/Node 22, Express, multer, Zod, PostgreSQL (pg), vitest.

## Global Constraints

- ESLint enforced: `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400 (file cap), `no-console` error, `@typescript-eslint/no-explicit-any` error, no non-null `!` outside tests.
- TypeScript strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (relative imports end `.js`; type-only imports use `import type`).
- Module-boundary error classes: every module owns a typed error extending `SpecrError`; chain `cause` at every catch that adds meaning. Validate external input with Zod, chain the `ZodError` as cause.
- `openapi.yaml` is the CI-enforced contract (ADR-026): the new route + every response/status shape must land in the SAME change or `contract.integration.test.ts` goes red three ways.
- Commit scope = module changed, Conventional Commits. Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>.
- Integration tests run against real Postgres. Run with `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test` exported; CI sequence is `migrate → seed → test → test:integration`.
- MCP parity, finalize/reopen (O-11), corrections/reclassify-API (O-9) are OUT OF SCOPE for #135.

---

## File Structure

- **Create `src/api/onboarding.ts`** — the handler (`importLibraryHandler`) + job orchestration (`processOnboardingJob`) + upload validation. Distinct from `libraries.ts` (keeps both under the 400-line cap; mirrors `parse.ts` being separate from `specs.ts`).
- **Modify `src/lib/jobs.ts`** — add an `OnboardingJob` result type + `createOnboardingJob`/`getOnboardingJob`/`updateOnboardingJob` over the same `Map` store, OR generalize. Decision: add a *separate* onboarding job store + types so the parse job contract (`ParseJobResult`) is untouched and the contract test for `/parse/jobs` keeps passing.
- **Modify `src/db/queries/specs.ts`** — extend `persistParsedSpec` to accept optional `libraryId` that overrides source-derived resolution.
- **Modify `src/db/index.ts`** — re-export the new onboarding-report builder if placed in db; otherwise no change (report assembly lives in the API layer).
- **Modify `src/api/router.ts`** — register `POST /libraries/:id/import` with the shared `parseRateLimit` + `upload.single('file')`.
- **Modify `openapi.yaml`** — add the path + `OnboardingJob`, `OnboardingJobResult`, `OnboardingReport`, `EditabilitySummary` schemas; reuse `DerivationReport`, `ParseWarning`, `ParseStage`.
- **Create `src/api/onboarding.integration.test.ts`** — acceptance-criterion tests against real Postgres.
- **Modify `src/api/contract.integration.test.ts`** — allowlist or assert the new op + new job-poll op.

---

## Task 1: Extend `persistParsedSpec` with explicit `libraryId`

**Files:**
- Modify: `src/db/queries/specs.ts` (the `persistParsedSpec` function, ~line 273)
- Test: `src/db/queries/specs.integration.test.ts` (create if absent — check first with `ls src/db/queries/specs.integration.test.ts`)

**Interfaces:**
- Produces: `persistParsedSpec(result: { tree; refs; originMeta?; libraryId?: string }): Promise<string>` — when `libraryId` is supplied it is used verbatim for the INSERT, the `ON CONFLICT` target, and `reconcileLibraryDivisionGeneralSpec`; when omitted, behavior is exactly as today (resolve from `source`).

- [ ] **Step 1: Write the failing test**

First check for an existing test file: `ls src/db/queries/specs.integration.test.ts`. If it exists, append; if not, create it with the standard integration harness (import `pool` from `../index.js`, an `afterAll` closing the pool, an `afterEach`/cleanup deleting test rows). Add:

```typescript
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { pool, persistParsedSpec, createLibrary } from '../index.js';
import type { SpecTree } from '../../ast/types.js';

const TEST_LIB = 'lib-persist-target-test';

afterEach(async () => {
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name = $1)`,
    [TEST_LIB]
  );
  await pool.query(`DELETE FROM libraries WHERE name = $1`, [TEST_LIB]);
});

afterAll(async () => {
  await pool.end();
});

describe('persistParsedSpec — explicit libraryId target (O-8)', () => {
  it('persists the spec into the supplied library, not the source-derived one', async () => {
    const lib = await createLibrary({ tier: 'company', name: TEST_LIB, owner: TEST_LIB });
    const tree: SpecTree = {
      id: 'placeholder',
      section: '09 91 26',
      title: 'Interior Painting',
      parts: [
        {
          id: 'n1',
          type: 'part',
          text: 'PART 1 GENERAL',
          children: [],
          // a 'ufgs' source would normally route to the UFGS Reference library —
          // the explicit libraryId must win.
          meta: { source: 'ufgs' },
        },
      ],
    };
    const specId = await persistParsedSpec({ tree, refs: [], libraryId: lib.id });
    const row = await pool.query<{ library_id: string }>(
      `SELECT library_id FROM specs WHERE id = $1`,
      [specId]
    );
    expect(row.rows[0]?.library_id).toBe(lib.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration src/db/queries/specs.integration.test.ts -t "explicit libraryId"`
Expected: FAIL — the spec lands in the UFGS Reference library (source-derived), not `lib.id` (the `libraryId` param does not exist yet, so TS will also error: "Object literal may only specify known properties").

- [ ] **Step 3: Implement the explicit-libraryId override**

In `src/db/queries/specs.ts`, change the `persistParsedSpec` signature and the library resolution line:

```typescript
export async function persistParsedSpec(result: {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly originMeta?: OriginMeta;
  /** Explicit owning library (O-8 onboarding). Omitted → resolved from source. */
  readonly libraryId?: string;
}): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // eslint-disable-next-line sonarjs/todo-tag
    // TODO: source should be a top-level SpecTree field — parts[0].meta.source is a stopgap
    const source = result.tree.parts[0]?.meta.source ?? 'unknown';
    const libraryId = result.libraryId ?? (await resolveDefaultLibraryId(source, client));
```

The rest of the function body is unchanged (`libraryId` already feeds the INSERT, the `ON CONFLICT`, and `reconcileLibraryDivisionGeneralSpec`).

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration src/db/queries/specs.integration.test.ts -t "explicit libraryId"`
Expected: PASS

- [ ] **Step 5: Confirm no regression in the existing parse path**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration src/api/parse.integration.test.ts`
Expected: PASS (the omitted-libraryId default path is untouched).

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/specs.ts src/db/queries/specs.integration.test.ts
git commit -m "feat(db): persistParsedSpec accepts explicit libraryId target

O-8 onboarding targets an explicit ADR-015 library; the source-derived
default resolution remains the behavior when libraryId is omitted.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Onboarding job substrate in `lib/jobs.ts`

**Files:**
- Modify: `src/lib/jobs.ts`
- Test: `src/lib/jobs.test.ts` (create if absent — `ls src/lib/jobs.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type OnboardingStage = 'queued' | 'running' | 'parsing' | 'persisting' | 'deriving-style' | 'classifying' | 'complete' | 'failed'`
  - `interface EditabilitySummary { readonly counts: Record<Editability, number>; readonly lowConfidence: readonly { readonly nodeId: string; readonly value: Editability; readonly confidence: number }[] }`
  - `interface OnboardingReport { readonly styleDerivation: DerivationReport | null; readonly styleSourceNeeded: boolean; readonly editability: EditabilitySummary; readonly parseWarnings: readonly ParseWarning[] }`
  - `interface OnboardingJobResult { readonly specId: string; readonly section: string; readonly title: string; readonly libraryId: string; readonly templateId: string | null; readonly report: OnboardingReport }`
  - `interface OnboardingJob { readonly jobId: string; readonly status: OnboardingStage; readonly progress: { readonly stage: OnboardingStage; readonly pct: number }; readonly result?: OnboardingJobResult; readonly error?: string; readonly expiresAt: number }`
  - `createOnboardingJob(): string`
  - `updateOnboardingJob(jobId, update: { status?; stage?; pct?; result?; error? }): void`
  - `getOnboardingJob(jobId): OnboardingJob | undefined`

- [ ] **Step 1: Write the failing test**

Create/append `src/lib/jobs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  createOnboardingJob,
  updateOnboardingJob,
  getOnboardingJob,
} from './jobs.js';

describe('onboarding job lifecycle', () => {
  it('creates queued, advances stage, then completes with a result', () => {
    const jobId = createOnboardingJob();
    expect(getOnboardingJob(jobId)?.status).toBe('queued');

    updateOnboardingJob(jobId, { status: 'running', stage: 'parsing', pct: 20 });
    expect(getOnboardingJob(jobId)?.progress.stage).toBe('parsing');

    updateOnboardingJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: {
        specId: 's1',
        section: '09 91 26',
        title: 'Painting',
        libraryId: 'lib1',
        templateId: null,
        report: {
          styleDerivation: null,
          styleSourceNeeded: true,
          editability: { counts: { locked: 0, editable: 0, choice: 0, note: 0 }, lowConfidence: [] },
          parseWarnings: [],
        },
      },
    });
    const done = getOnboardingJob(jobId);
    expect(done?.status).toBe('complete');
    expect(done?.result?.styleSourceNeeded ?? done?.result?.report.styleSourceNeeded).toBe(true);
  });

  it('returns undefined for an unknown job id', () => {
    expect(getOnboardingJob('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/jobs.test.ts`
Expected: FAIL — `createOnboardingJob` is not exported.

- [ ] **Step 3: Implement the onboarding job store**

Append to `src/lib/jobs.ts` (keep the existing parse-job code untouched; add a *separate* map so the two contracts never collide). Add the imports at the top of the file (VERIFIED export locations: `ParseWarning` is an `interface` in `src/ast/types.ts`, NOT in the parser barrel; `Editability` is re-exported from `src/ast/index.js`; `DerivationReport` IS in the parser barrel):

```typescript
import type { DerivationReport } from '../parser/index.js';
import type { ParseWarning } from '../ast/types.js';
import type { Editability } from '../ast/index.js';
```

Then append:

```typescript
// ── Onboarding jobs (O-8) ─────────────────────────────────────────────────────
// A separate store + result contract from parse jobs: the onboarding report has
// three sections (style derivation, editability summary, parse warnings) that do
// not fit ParseJobResult, and /parse/jobs must keep its existing schema.

export type OnboardingStage =
  | 'queued'
  | 'running'
  | 'parsing'
  | 'persisting'
  | 'deriving-style'
  | 'classifying'
  | 'complete'
  | 'failed';

export interface EditabilitySummary {
  /** One count per closed editability value (ADR-022 D1). Always all four keys. */
  readonly counts: Record<Editability, number>;
  /** Classified paragraphs whose machine confidence is below the review threshold. */
  readonly lowConfidence: readonly {
    readonly nodeId: string;
    readonly value: Editability;
    readonly confidence: number;
  }[];
}

export interface OnboardingReport {
  /** WT-3 consensus style derivation audit; null for non-DOCX sources. */
  readonly styleDerivation: DerivationReport | null;
  /** True when no style template was derived (non-DOCX) — assign via O-12 later. */
  readonly styleSourceNeeded: boolean;
  readonly editability: EditabilitySummary;
  readonly parseWarnings: readonly ParseWarning[];
}

export interface OnboardingJobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly libraryId: string;
  /** Derived style template id (DOCX) or null (non-DOCX). */
  readonly templateId: string | null;
  readonly report: OnboardingReport;
}

export interface OnboardingJob {
  readonly jobId: string;
  readonly status: OnboardingStage;
  readonly progress: { readonly stage: OnboardingStage; readonly pct: number };
  readonly result?: OnboardingJobResult;
  readonly error?: string;
  readonly expiresAt: number;
}

const onboardingJobs = new Map<string, OnboardingJob>();

export function createOnboardingJob(): string {
  const jobId = uuidv4();
  onboardingJobs.set(jobId, {
    jobId,
    status: 'queued',
    progress: { stage: 'queued', pct: 0 },
    expiresAt: Date.now() + JOB_TTL_MS,
  });
  setTimeout(() => onboardingJobs.delete(jobId), JOB_TTL_MS).unref();
  return jobId;
}

export function updateOnboardingJob(
  jobId: string,
  update: {
    readonly status?: OnboardingStage;
    readonly stage?: OnboardingStage;
    readonly pct?: number;
    readonly result?: OnboardingJobResult;
    readonly error?: string;
  }
): void {
  const job = onboardingJobs.get(jobId);
  if (!job) return;
  onboardingJobs.set(jobId, {
    ...job,
    ...(update.status !== undefined ? { status: update.status } : {}),
    progress: {
      stage: update.stage ?? job.progress.stage,
      pct: update.pct ?? job.progress.pct,
    },
    ...(update.result !== undefined ? { result: update.result } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
  });
}

export function getOnboardingJob(jobId: string): OnboardingJob | undefined {
  return onboardingJobs.get(jobId);
}
```

(Import sources already verified above — no further grep needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/jobs.test.ts`
Expected: PASS

- [ ] **Step 5: Lint the file**

Run: `pnpm exec eslint src/lib/jobs.ts && pnpm exec tsc --noEmit`
Expected: no errors. If `jobs.ts` now exceeds 400 lines, extract the onboarding job code into `src/lib/onboarding-jobs.ts` and re-export — but it should fit (the file is currently ~73 lines).

- [ ] **Step 6: Commit**

```bash
git add src/lib/jobs.ts src/lib/jobs.test.ts
git commit -m "feat(jobs): onboarding job store + three-section report contract

Separate from parse jobs so /parse/jobs keeps its ParseJobResult schema;
the onboarding report carries style derivation, an editability summary,
and parse warnings (O-8).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: The editability summary builder (pure)

**Files:**
- Create: `src/api/onboarding-report.ts` (small pure helper — keeps `onboarding.ts` focused and under the line cap)
- Test: `src/api/onboarding-report.test.ts`

**Interfaces:**
- Consumes: a `SpecTree` (from `getSpecTree(specId)` → `result.tree`), `SpecNode` with `meta.editability` populated after classification.
- Produces:
  - `const LOW_CONFIDENCE_THRESHOLD = 0.6`
  - `summarizeEditability(tree: SpecTree, threshold?: number): EditabilitySummary` — pre-order walk; counts the effective value per classified node; lists nodes whose machine `confidence` < threshold. Unclassified nodes (no `meta.editability`) are skipped (structural nodes — `part`/`note`/`continuation` may carry no classification).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { summarizeEditability, LOW_CONFIDENCE_THRESHOLD } from './onboarding-report.js';
import type { SpecTree, SpecNode } from '../ast/types.js';

function node(id: string, value: 'locked' | 'editable' | 'choice' | 'note', confidence: number): SpecNode {
  return {
    id,
    type: 'item',
    text: id,
    children: [],
    meta: {
      editability: {
        value,
        confidence,
        evidence: [{ rule: 'defaultEditability', fact: 'none' }],
      },
    },
  };
}

const tree: SpecTree = {
  id: 's1',
  section: '09 91 26',
  title: 'Painting',
  parts: [
    node('a', 'editable', 0.9),
    node('b', 'editable', 0.4), // low-confidence
    {
      id: 'p',
      type: 'part',
      text: 'PART 1',
      children: [node('c', 'locked', 0.95), node('d', 'note', 0.5)], // d low-confidence
      meta: {}, // structural, unclassified — skipped
    },
  ],
};

describe('summarizeEditability', () => {
  it('counts effective values across the whole tree and flags low-confidence nodes', () => {
    const summary = summarizeEditability(tree);
    expect(summary.counts).toEqual({ locked: 1, editable: 2, choice: 0, note: 1 });
    expect(summary.lowConfidence.map((e) => e.nodeId).sort()).toEqual(['b', 'd']);
    expect(summary.lowConfidence.every((e) => e.confidence < LOW_CONFIDENCE_THRESHOLD)).toBe(true);
  });

  it('returns all-zero counts and empty list for a tree with no classifications', () => {
    const bare: SpecTree = { id: 's', section: 'x', title: 'y', parts: [] };
    expect(summarizeEditability(bare)).toEqual({
      counts: { locked: 0, editable: 0, choice: 0, note: 0 },
      lowConfidence: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit src/api/onboarding-report.test.ts`
Expected: FAIL — module not found / `summarizeEditability` not exported.

- [ ] **Step 3: Implement the pure builder**

```typescript
import type { SpecTree, SpecNode } from '../ast/types.js';
import type { Editability } from '../ast/index.js';
import type { EditabilitySummary } from '../lib/jobs.js';

/** Below this machine confidence, a classification is surfaced for human review. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

interface Acc {
  readonly counts: Record<Editability, number>;
  readonly lowConfidence: { nodeId: string; value: Editability; confidence: number }[];
}

function walk(nodes: readonly SpecNode[], acc: Acc, threshold: number): void {
  for (const n of nodes) {
    const e = n.meta.editability;
    if (e) {
      acc.counts[e.value] += 1;
      if (e.confidence < threshold) {
        acc.lowConfidence.push({ nodeId: n.id, value: e.value, confidence: e.confidence });
      }
    }
    walk(n.children, acc, threshold);
  }
}

/**
 * Summarize a classified spec tree (O-8 report §editability): counts of the
 * effective editability value per closed vocabulary entry, plus the nodes whose
 * machine confidence falls below the review threshold. Pure over the tree —
 * unclassified (structural) nodes are skipped.
 */
export function summarizeEditability(
  tree: SpecTree,
  threshold: number = LOW_CONFIDENCE_THRESHOLD
): EditabilitySummary {
  const acc: Acc = {
    counts: { locked: 0, editable: 0, choice: 0, note: 0 },
    lowConfidence: [],
  };
  walk(tree.parts, acc, threshold);
  return { counts: acc.counts, lowConfidence: acc.lowConfidence };
}
```

(`Editability` is the closed four-value type re-exported from `../ast/index.js` — already imported above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit src/api/onboarding-report.test.ts`
Expected: PASS

- [ ] **Step 5: Lint**

Run: `pnpm exec eslint src/api/onboarding-report.ts && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/onboarding-report.ts src/api/onboarding-report.test.ts
git commit -m "feat(api): editability summary builder for onboarding report

Pure pre-order walk over a classified tree → per-value counts + a
low-confidence review list (O-8 report §editability).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: The import handler + pipeline (`src/api/onboarding.ts`)

**Files:**
- Create: `src/api/onboarding.ts`
- (No standalone unit test — covered by the Task 6 integration test against real Postgres + parse pool.)

**Interfaces:**
- Consumes: `createOnboardingJob`/`updateOnboardingJob` (Task 2), `summarizeEditability` (Task 3), `persistParsedSpec` w/ `libraryId` (Task 1), `findLibraryById`, `analyzeDocxStyles`, `deriveTemplate`, `createTemplateWithRules`, `setSpecStyleSource`, `reclassifySpec`, `getSpecTree`, `parsePool`, `assertDocxSafe`/`assertSecSafe`.
- Produces: `importLibraryHandler(req, res): Promise<void>` and `importJobHandler(req, res): void` (the job poller). Both registered in Task 5.

**Design notes (the implementer MUST follow):**
- The handler validates `:id` is a UUID (400 on malformed), validates the library exists (404), validates the upload (extension/MIME/zip safety — same hardening as `parse.ts`: `ALLOWED_EXT` = `.docx|.sec|.txt`, MIME check for `.docx`, `assertDocxSafe`/`assertSecSafe`), creates the job, returns `202 {jobId}`, and runs `processOnboardingJob` off-thread (`void processOnboardingJob(...)`).
- The pipeline runs inside one `try/catch`; any failure calls `updateOnboardingJob(jobId, { status: 'failed', error: <cause-chained message> })`. Use the same `jobErrorMessage`-style extraction.
- Reuse the SHARED `upload` multer instance and `parseRateLimit` from `parse.ts`/`router.ts` (Task 5 wires them).
- The function MUST stay under 50 lines each. Split the pipeline into: `runParseAndPersist`, `deriveStyleIfDocx`, `classifyAndSummarize`, `processOnboardingJob` orchestrator. Each is a named helper.

- [ ] **Step 1: Write the handler + pipeline**

Create `src/api/onboarding.ts`:

```typescript
import path from 'node:path';
import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  assertDocxSafe,
  assertSecSafe,
  analyzeDocxStyles,
  deriveTemplate,
} from '../parser/index.js';
import {
  findLibraryById,
  persistParsedSpec,
  createTemplateWithRules,
  setSpecStyleSource,
  reclassifySpec,
  getSpecTree,
} from '../db/index.js';
import type { OriginMeta } from '../db/index.js';
import {
  createOnboardingJob,
  updateOnboardingJob,
  getOnboardingJob,
  type OnboardingStage,
  type OnboardingReport,
  type OnboardingJobResult,
} from '../lib/jobs.js';
import { parsePool } from '../lib/parse-pool.js';
import type { WorkerOutput } from '../lib/parse-worker.js';
import { summarizeEditability } from './onboarding-report.js';
import { logger } from '../lib/logger.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';
import type { SpecTree } from '../ast/types.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_EXT = new Set(['.docx', '.sec', '.txt']);
const UUID_SCHEMA = z.uuid();

type UploadValidation = { error: string } | { file: Express.Multer.File; ext: string };

async function validateUpload(req: Request): Promise<UploadValidation> {
  if (!req.file) return { error: 'file required' };
  const file = req.file;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { error: 'unsupported file extension' };
  if (ext === '.txt') return { file, ext };
  if (ext === '.docx' && file.mimetype !== DOCX_MIME) return { error: 'MIME type mismatch for .docx' };
  try {
    if (ext === '.docx') await assertDocxSafe(file.buffer);
    else assertSecSafe(file.buffer);
    return { file, ext };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid file' };
  }
}

function buildOriginMeta(filename: string, buffer: Buffer): OriginMeta {
  return { filename: sanitizeFilename(filename), sha256: sha256Hex(buffer), loader: 'rest:onboarding' };
}

function jobErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'onboarding failed';
}

export async function importLibraryHandler(req: Request, res: Response): Promise<void> {
  const libId = UUID_SCHEMA.safeParse(req.params['id']);
  if (!libId.success) {
    res.status(400).json({ success: false, error: 'invalid library id' });
    return;
  }
  const validation = await validateUpload(req);
  if ('error' in validation) {
    res.status(400).json({ success: false, error: validation.error });
    return;
  }
  try {
    const library = await findLibraryById(libId.data);
    if (!library) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
  } catch (err) {
    logger.error({ err }, 'onboarding library lookup failed');
    res.status(500).json({ success: false, error: 'internal server error' });
    return;
  }
  const { file, ext } = validation;
  const jobId = createOnboardingJob();
  void processOnboardingJob(jobId, file.buffer, ext, libId.data, file.originalname);
  res.status(202).json({ success: true, data: { jobId } });
}

export function importJobHandler(req: Request, res: Response): void {
  const jobId = req.params['jobId'];
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'missing jobId' });
    return;
  }
  const job = getOnboardingJob(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'job not found' });
    return;
  }
  res.status(200).json({ success: true, data: job });
}
```

- [ ] **Step 2: Add the pipeline helpers in the same file**

Append the orchestration. Keep each helper ≤ 50 lines:

```typescript
function progress(jobId: string, stage: OnboardingStage, pct: number): void {
  updateOnboardingJob(jobId, { status: 'running', stage, pct });
}

// Parse off-thread then persist into the target library. Returns the spec id +
// the parsed tree (for warnings) + ext.
async function runParseAndPersist(
  jobId: string,
  buffer: Buffer,
  ext: string,
  libraryId: string,
  filename: string
): Promise<{ specId: string; tree: SpecTree }> {
  progress(jobId, 'parsing', 20);
  const workerRaw: unknown = await parsePool.run({ buffer, ext });
  const { tree, refs } = workerRaw as WorkerOutput;
  progress(jobId, 'persisting', 50);
  const specId = await persistParsedSpec({
    tree,
    refs,
    libraryId,
    originMeta: buildOriginMeta(filename, buffer),
  });
  return { specId, tree };
}

// DOCX-only: derive a consensus style template and link it to the spec. Returns
// the template id + derivation report, or nulls (non-DOCX → style source needed).
async function deriveStyleIfDocx(
  jobId: string,
  buffer: Buffer,
  ext: string,
  specId: string,
  section: string
): Promise<{ templateId: string | null; report: OnboardingReport['styleDerivation'] }> {
  if (ext !== '.docx') return { templateId: null, report: null };
  progress(jobId, 'deriving-style', 70);
  const analysis = await analyzeDocxStyles(buffer);
  const { rules, report } = deriveTemplate(analysis.classified, analysis.effectiveStyles);
  if (rules.length === 0) return { templateId: null, report };
  const name = `onboarded:${specId}:${section}`;
  let templateId: string | null = null;
  try {
    const template = await createTemplateWithRules(name, null, rules);
    templateId = template.id;
    await setSpecStyleSource(specId, template.id);
  } catch (err) {
    // A duplicate template name (23505) on re-import is non-fatal: the style
    // report still surfaces. Re-throw anything else (it fails the job loudly).
    if (!pgErrorToHttp(err, { '23505': 'dup' })) throw err;
  }
  return { templateId, report };
}
```

- [ ] **Step 3: Add the classify+summarize step and the orchestrator**

```typescript
// Classify editability against the library's convention profile (or the built-in
// default — reclassifySpec resolves it), then read the persisted tree back and
// summarize. reclassifySpec stores classifications; getSpecTree returns the
// effective editability per node for the summary.
async function classifyAndSummarize(jobId: string, specId: string): Promise<OnboardingReport['editability']> {
  progress(jobId, 'classifying', 85);
  await reclassifySpec(specId, {});
  const treeResult = await getSpecTree(specId);
  if (!treeResult) throw new Error('classified spec vanished before summary');
  return summarizeEditability(treeResult.tree);
}

async function processOnboardingJob(
  jobId: string,
  buffer: Buffer,
  ext: string,
  libraryId: string,
  filename: string
): Promise<void> {
  try {
    const { specId, tree } = await runParseAndPersist(jobId, buffer, ext, libraryId, filename);
    const style = await deriveStyleIfDocx(jobId, buffer, ext, specId, tree.section);
    const editability = await classifyAndSummarize(jobId, specId);
    const report: OnboardingReport = {
      styleDerivation: style.report,
      styleSourceNeeded: style.templateId === null,
      editability,
      parseWarnings: tree.warnings ?? [],
    };
    const result: OnboardingJobResult = {
      specId,
      section: tree.section,
      title: tree.title,
      libraryId,
      templateId: style.templateId,
      report,
    };
    updateOnboardingJob(jobId, { status: 'complete', stage: 'complete', pct: 100, result });
  } catch (err) {
    logger.error({ err, jobId }, 'onboarding job failed');
    updateOnboardingJob(jobId, { status: 'failed', error: jobErrorMessage(err) });
  }
}
```

- [ ] **Step 4: Lint + typecheck**

Run: `pnpm exec eslint src/api/onboarding.ts && pnpm exec tsc --noEmit`
Expected: no errors. Common fixes:
- If `tree.warnings` is not on `SpecTree`, check `grep -n "warnings" src/ast/types.ts`; it is optional (`warnings?: readonly ParseWarning[]`). Use `tree.warnings ?? []`.
- If a worker output needs Zod re-validation (parse.ts uses `workerOutputSchema.parse`), prefer reusing it: import `workerOutputSchema` from `parse.ts` is not exported — instead cast via the same `as WorkerOutput` the worker contract guarantees, OR (cleaner) export `workerOutputSchema` from `parse.ts` and parse here. Decision: cast `as WorkerOutput` to match the worker's own typed return (the worker already validated structurally); do NOT introduce `any`.
- If the file exceeds 400 lines (unlikely — ~180), extract `validateUpload`/`buildOriginMeta` into a shared `src/api/upload-validation.ts` and import from both `parse.ts` and `onboarding.ts`. Only do this if over budget.

- [ ] **Step 5: Commit**

```bash
git add src/api/onboarding.ts
git commit -m "feat(api): library import onboarding pipeline (O-8)

POST handler + async job orchestration: parse → persist into the target
library → derive DOCX style template → classify editability → assemble
the three-section onboarding report. Non-DOCX flags styleSourceNeeded
rather than failing. Bytes discarded after parse (ADR-021).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire the routes + openapi contract

**Files:**
- Modify: `src/api/router.ts`
- Modify: `openapi.yaml`
- Modify: `src/api/contract.integration.test.ts` (allowlist the two new ops)

**Interfaces:**
- Consumes: `importLibraryHandler`, `importJobHandler` (Task 4); `upload`, `parseRateLimit` (already in `router.ts`/`parse.ts`).
- Produces: routes `POST /libraries/:id/import` and `GET /libraries/import/jobs/:jobId`.

**Design note:** the job-poll path must NOT collide with `GET /libraries/:id/specs` or `GET /libraries/:id/conventions`. Use a distinct, non-`:id` segment: `GET /libraries/import/jobs/:jobId` (Express matches the literal `import` before the `:id` param only if registered first — register the literal route BEFORE the `:id` routes, OR use a path that cannot be a UUID like `/libraries/import/jobs/:jobId`; a `:id` route only matches a single segment so `/libraries/import/jobs/x` has 3 segments after `/libraries` and won't match `/libraries/:id/...` two-segment patterns — verify the contract test passes).

- [ ] **Step 1: Register the routes**

In `src/api/router.ts`, add the import to the existing import block:

```typescript
import { importLibraryHandler, importJobHandler } from './onboarding.js';
```

Then add the routes near the other `/libraries` routes (register the job-poll route and the import route; `upload`/`parseRateLimit` already imported from `./parse.js`):

```typescript
router.post(
  '/libraries/:id/import',
  parseRateLimit,
  upload.single('file'),
  importLibraryHandler
);
router.get('/libraries/import/jobs/:jobId', importJobHandler);
```

- [ ] **Step 2: Run the contract structural test (expect RED)**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration src/api/contract.integration.test.ts -t "every Express route is documented"`
Expected: FAIL — "Express routes missing from openapi.yaml" lists `post /libraries/{}/import` and `get /libraries/import/jobs/{}`.

- [ ] **Step 3: Document both ops in `openapi.yaml`**

Add under `paths:` (place near the other `/libraries` paths). Reuse existing schemas where possible:

```yaml
  /libraries/{id}/import:
    post:
      operationId: importLibraryMaster
      summary: Onboard a master document into a library (async)
      description: >
        Upload a `.docx`, `.sec`, or `.txt` master document into the target
        ADR-015 library. Returns 202 with a `jobId`; poll
        `/libraries/import/jobs/{jobId}` for progress and the onboarding report.
        The pipeline parses (capturing source facts), persists the spec into the
        library, derives a style template (DOCX only), and classifies editability
        using the library's convention profile or the built-in default. Source
        bytes are discarded after parse (ADR-021). Rate-limited to 10 requests
        per IP per minute (shared with `POST /parse`).
      tags: [libraries]
      parameters:
        - $ref: '#/components/parameters/LibraryId'
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [file]
              properties:
                file:
                  type: string
                  format: binary
                  description: Master document (.docx, .sec, or .txt). Max 10 MB.
      responses:
        '202':
          description: Onboarding job accepted
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        type: object
                        required: [jobId]
                        properties:
                          jobId:
                            type: string
                            format: uuid
        '400':
          $ref: '#/components/responses/BadRequest'
        '404':
          $ref: '#/components/responses/NotFound'
        '429':
          $ref: '#/components/responses/TooManyRequests'
        '500':
          $ref: '#/components/responses/InternalServerError'

  /libraries/import/jobs/{jobId}:
    get:
      operationId: getOnboardingJob
      summary: Poll a library-onboarding job
      tags: [libraries]
      parameters:
        - name: jobId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Onboarding job status
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/SuccessResponse'
                  - type: object
                    required: [data]
                    properties:
                      data:
                        $ref: '#/components/schemas/OnboardingJob'
        '404':
          $ref: '#/components/responses/NotFound'
        '500':
          $ref: '#/components/responses/InternalServerError'
```

Verify `#/components/parameters/LibraryId` exists (`grep -n "LibraryId:" openapi.yaml`). If the existing `/libraries/{id}/...` paths use an inline `id` param instead, copy that exact inline param form rather than `$ref`.

- [ ] **Step 4: Add the schemas to `openapi.yaml` components**

Under `components: schemas:`, add (reuse `DerivationReport`, `ParseWarning`, and define an `Editability` enum + `ParseStage`-like `OnboardingStage`):

```yaml
    OnboardingStage:
      type: string
      enum: [queued, running, parsing, persisting, deriving-style, classifying, complete, failed]

    EditabilityValue:
      type: string
      enum: [locked, editable, choice, note]

    EditabilitySummary:
      type: object
      required: [counts, lowConfidence]
      properties:
        counts:
          type: object
          required: [locked, editable, choice, note]
          properties:
            locked: { type: integer }
            editable: { type: integer }
            choice: { type: integer }
            note: { type: integer }
        lowConfidence:
          type: array
          items:
            type: object
            required: [nodeId, value, confidence]
            properties:
              nodeId: { type: string, format: uuid }
              value: { $ref: '#/components/schemas/EditabilityValue' }
              confidence: { type: number, minimum: 0, maximum: 1 }

    OnboardingReport:
      type: object
      required: [styleDerivation, styleSourceNeeded, editability, parseWarnings]
      properties:
        styleDerivation:
          oneOf:
            - $ref: '#/components/schemas/DerivationReport'
            - type: 'null'
          description: WT-3 consensus style derivation audit; null for non-DOCX masters.
        styleSourceNeeded:
          type: boolean
          description: True when no style template was derived (non-DOCX) — assign via O-12.
        editability:
          $ref: '#/components/schemas/EditabilitySummary'
        parseWarnings:
          type: array
          items:
            $ref: '#/components/schemas/ParseWarning'

    OnboardingJobResult:
      type: object
      required: [specId, section, title, libraryId, templateId, report]
      properties:
        specId: { type: string, format: uuid }
        section: { type: string }
        title: { type: string }
        libraryId: { type: string, format: uuid }
        templateId:
          type: [string, 'null']
          description: Derived style template id (DOCX) or null (non-DOCX).
        report:
          $ref: '#/components/schemas/OnboardingReport'

    OnboardingJob:
      type: object
      required: [jobId, status, progress, expiresAt]
      properties:
        jobId: { type: string, format: uuid }
        status: { $ref: '#/components/schemas/OnboardingStage' }
        progress:
          type: object
          required: [stage, pct]
          properties:
            stage: { $ref: '#/components/schemas/OnboardingStage' }
            pct: { type: number, minimum: 0, maximum: 100 }
        result:
          $ref: '#/components/schemas/OnboardingJobResult'
        error: { type: string }
        expiresAt:
          type: integer
          description: Job record expiry as a Unix epoch timestamp in milliseconds.
```

- [ ] **Step 5: Allowlist the new ops in the contract test**

In `src/api/contract.integration.test.ts`, add to the `RESPONSE_ALLOWLIST` set (the 202/structural ops that are not deep-response-asserted there — the dedicated integration test in Task 6 covers behavior):

```typescript
  'post /libraries/{}/import',
  'get /libraries/import/jobs/{}',
```

- [ ] **Step 6: Run the full contract test (expect GREEN)**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration src/api/contract.integration.test.ts`
Expected: PASS — both structural-coverage and success-JSON-coverage assertions green.

- [ ] **Step 7: Commit**

```bash
git add src/api/router.ts openapi.yaml src/api/contract.integration.test.ts
git commit -m "feat(api): wire POST /libraries/:id/import + onboarding job poll (O-8)

Routes registered with the shared parse rate-limit + multer; openapi.yaml
gains the path and OnboardingJob/Report/EditabilitySummary schemas so the
contract gate stays green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Acceptance-criterion integration tests

**Files:**
- Create: `src/api/onboarding.integration.test.ts`

**Interfaces:**
- Consumes: the live `router`, real Postgres, the `.docx` fixture `tests/fixtures/libreoffice/csi-spec-sample.docx`, and the `.sec` fixture `docs/references/UFGS/DIVISION_01/01_11_00.SEC`.

**Acceptance criteria mapped to tests:**
1. DOCX import → job completes → report has all three sections; spec + template + classifications in DB.
2. `.sec`/`.txt` import works; report flags `styleSourceNeeded: true` instead of failing.
3. Unknown library → 404; malformed upload → 400 with cause-chained error.
4. Hardening (#23 path): the rate-limit + zip validation apply (covered by reusing the shared `upload`/`parseRateLimit` and asserting a `.xyz`/bad-MIME 400).

- [ ] **Step 1: Write the integration tests**

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  await pool.end();
});

const LIB = 'lib-onboard-test';

afterEach(async () => {
  await pool.query(
    `DELETE FROM style_templates WHERE id IN (
       SELECT style_template_id FROM specs
       WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-onboard-%')
         AND style_template_id IS NOT NULL)`
  );
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-onboard-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-onboard-%'`);
});

interface OnboardingJobData {
  status: string;
  error?: string;
  result?: {
    specId: string;
    templateId: string | null;
    report: {
      styleDerivation: unknown;
      styleSourceNeeded: boolean;
      editability: { counts: Record<string, number>; lowConfidence: unknown[] };
      parseWarnings: unknown[];
    };
  };
}

async function waitForJob(jobId: string, maxMs = 25_000): Promise<OnboardingJobData> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/libraries/import/jobs/${jobId}`);
    const body = (await res.json()) as { data: OnboardingJobData };
    if (body.data.status === 'complete' || body.data.status === 'failed') return body.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`onboarding job ${jobId} did not finish`);
}

async function importFile(libraryId: string, bytes: Buffer, name: string, type: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${baseUrl}/libraries/${libraryId}/import`, { method: 'POST', body: form });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { data: { jobId: string } };
  return body.data.jobId;
}

describe('POST /libraries/:id/import (O-8)', () => {
  it('DOCX import → completes with all three report sections + spec/template/classifications in DB', async () => {
    const lib = await createLibrary({ tier: 'company', name: LIB, owner: LIB });
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));
    const jobId = await importFile(
      lib.id,
      docx,
      'sample.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const job = await waitForJob(jobId);
    expect(job.status, job.error).toBe('complete');
    expect(job.result).toBeDefined();
    const r = job.result!;
    // three sections present
    expect(r.report.styleDerivation).not.toBeNull();
    expect(r.report.styleSourceNeeded).toBe(false);
    expect(r.report.editability).toBeDefined();
    expect(Array.isArray(r.report.parseWarnings)).toBe(true);
    // spec landed in the target library
    const spec = await pool.query<{ library_id: string; style_template_id: string | null }>(
      `SELECT library_id, style_template_id FROM specs WHERE id = $1`,
      [r.specId]
    );
    expect(spec.rows[0]?.library_id).toBe(lib.id);
    expect(spec.rows[0]?.style_template_id).toBe(r.templateId);
    expect(r.templateId).not.toBeNull();
    // classifications persisted
    const classified = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1 AND classification IS NOT NULL`,
      [r.specId]
    );
    expect(parseInt(classified.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  }, 40_000);

  it('.sec import works and flags styleSourceNeeded instead of failing', async () => {
    const lib = await createLibrary({ tier: 'company', name: `${LIB}-sec`, owner: `${LIB}-sec` });
    const sec = readFileSync(resolve('docs/references/UFGS/DIVISION_01/01_11_00.SEC'));
    const jobId = await importFile(lib.id, sec, '01_11_00.sec', 'text/plain');
    const job = await waitForJob(jobId);
    expect(job.status, job.error).toBe('complete');
    expect(job.result?.report.styleSourceNeeded).toBe(true);
    expect(job.result?.report.styleDerivation).toBeNull();
    expect(job.result?.templateId).toBeNull();
  }, 40_000);

  it('unknown library → 404', async () => {
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));
    const form = new FormData();
    form.append(
      'file',
      new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      'sample.docx'
    );
    const res = await fetch(`${baseUrl}/libraries/${'00000000-0000-0000-0000-000000000000'}/import`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(404);
  });

  it('malformed upload (unsupported extension) → 400', async () => {
    const lib = await createLibrary({ tier: 'company', name: `${LIB}-bad`, owner: `${LIB}-bad` });
    const form = new FormData();
    form.append('file', new Blob(['nope'], { type: 'text/plain' }), 'bad.xyz');
    const res = await fetch(`${baseUrl}/libraries/${lib.id}/import`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('invalid library id → 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const res = await fetch(`${baseUrl}/libraries/not-a-uuid/import`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the integration tests**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration src/api/onboarding.integration.test.ts`
Expected: PASS (all 5). If the DOCX fixture yields zero style rules (so `styleSourceNeeded` is unexpectedly true), inspect the fixture: it is a real LibreOffice CSI sample and should produce rules. If it genuinely has no styled paragraphs, swap to whatever DOCX fixture `templates.integration.test.ts` uses — find it with `grep -rn "\.docx" src/api/templates.integration.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/api/onboarding.integration.test.ts
git commit -m "test(api): O-8 onboarding import acceptance tests

Covers every acceptance criterion: DOCX three-section report + DB state,
.sec styleSourceNeeded, 404 unknown library, 400 malformed upload + bad
library id.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full green gate + finishing

**Files:** none new — verification only.

- [ ] **Step 1: Lint (eslint + tsc + prettier)**

Run: `pnpm lint`
Expected: clean. Fix any complexity/line-cap violations by extracting helpers (already structured to fit). Run `pnpm format` if prettier flags formatting.

- [ ] **Step 2: Unit tests**

Run: `pnpm test`
Expected: PASS (includes `jobs.test.ts`, `onboarding-report.test.ts`).

- [ ] **Step 3: Integration tests (full suite)**

Run: `DATABASE_URL=postgres://specr:specr@localhost:5432/specr NODE_ENV=test pnpm exec vitest run --project integration`
Expected: PASS — especially `contract.integration.test.ts`, `onboarding.integration.test.ts`, `parse.integration.test.ts`, `libraries.integration.test.ts` (no regression).

- [ ] **Step 4: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`, choose option 2 (Push + PR). PR body MUST include `Closes #135`, a `## Design decisions` section, and the standard Unit/Integration/Manual/CI testing checklist. Conventional Commit title scope = `api`. Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>.

---

## Self-Review

**Spec coverage:**
- Scope item 1 (parse + source-fact capture) → Task 4 `runParseAndPersist` (reuses `parsePool` → `parse()` which captures source facts via `insertTree`). ✓
- Scope item 2 (persist into target library) → Task 1 (`persistParsedSpec` libraryId) + Task 4. ✓
- Scope item 3 (DOCX derive style; non-DOCX flag) → Task 4 `deriveStyleIfDocx` + `styleSourceNeeded`. ✓
- Scope item 4 (classify editability via library/built-in convention) → Task 4 `classifyAndSummarize` (reuses `reclassifySpec` which resolves the profile). ✓
- Scope item 5 (job result = three-section report) → Tasks 2 (types) + 3 (editability summary) + 4 (assembly). ✓
- Bytes discarded after parse (ADR-021) → buffer never persisted; only `originMeta` (sha + filename) stored. ✓
- AC: DOCX → all three sections + DB state → Task 6 test 1. ✓
- AC: .sec/.txt works + flags missing style → Task 6 test 2. ✓
- AC: 404 unknown / 400 malformed → Task 6 tests 3–5. ✓
- AC: #23 hardening applies → shared `upload` (10 MB, zip validation) + `parseRateLimit` reused (Task 5); bad-ext 400 asserted (Task 6 test 4). ✓
- openapi contract updated same change → Task 5. ✓

**Placeholder scan:** no TBD/TODO-as-instruction; every code step shows full code. The only `eslint-disable sonarjs/todo-tag` is pre-existing in `persistParsedSpec` and preserved verbatim. ✓

**Type consistency:** `OnboardingReport`/`OnboardingJobResult`/`EditabilitySummary` defined once in Task 2, consumed by name in Tasks 3–5 (report builder returns `EditabilitySummary`; handler assembles `OnboardingReport`/`OnboardingJobResult`). `summarizeEditability` named consistently across Tasks 3–4. `persistParsedSpec({..., libraryId})` shape consistent Tasks 1, 4. ✓

**Known risk to verify during execution:** the job-poll route `/libraries/import/jobs/:jobId` must not be shadowed by `/libraries/:id/...` routes. Express matches by segment count — `/libraries/import/jobs/{jobId}` is 3 segments after `/libraries`, while `/libraries/:id/specs` etc. are 2; they cannot collide. The contract structural test (Task 5 Step 6) is the gate that proves it.
