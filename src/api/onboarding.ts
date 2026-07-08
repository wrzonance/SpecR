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
  getTemplateByName,
  bulkUpsertTemplateRules,
  setSpecStyleSource,
  reclassifySpec,
  getSpecTree,
  getSpecSource,
} from '../db/index.js';
import type { OriginMeta, StyleRule } from '../db/index.js';
import {
  createOnboardingJob,
  updateOnboardingJob,
  getOnboardingJob,
  type OnboardingStage,
  type OnboardingReport,
  type OnboardingJobResult,
} from '../lib/jobs.js';
import { parsePool } from '../lib/parse-pool.js';
import { workerOutputSchema, type WorkerOutput } from '../lib/parse-worker.js';
import { summarizeEditability } from './onboarding-report.js';
import { summarizeHierarchy } from '../lib/hierarchy-summary.js';
import { logger } from '../lib/logger.js';
import { parseLog, logParseWarnings } from '../lib/log-context.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import { pgErrorToHttp } from '../lib/pg-errors.js';
import type { SpecTree } from '../ast/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_EXT = new Set(['.docx', '.sec', '.txt']);
const UUID_SCHEMA = z.uuid();

type UploadValidation = { error: string } | { file: Express.Multer.File; ext: string };

// Mirror the parse-path hardening (#23): extension allowlist, DOCX MIME match,
// and zip/XML safety validation before any work is scheduled.
async function validateUpload(req: Request): Promise<UploadValidation> {
  if (!req.file) return { error: 'file required' };
  const file = req.file;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { error: 'unsupported file extension' };
  if (ext === '.txt') return { file, ext };
  if (ext === '.docx' && file.mimetype !== DOCX_MIME)
    return { error: 'MIME type mismatch for .docx' };
  try {
    if (ext === '.docx') await assertDocxSafe(file.buffer);
    else assertSecSafe(file.buffer);
    return { file, ext };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid file' };
  }
}

function buildOriginMeta(filename: string, buffer: Buffer): OriginMeta {
  return {
    filename: sanitizeFilename(filename),
    sha256: sha256Hex(buffer),
    loader: 'rest:onboarding',
  };
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

// ── Pipeline ──────────────────────────────────────────────────────────────────

function progress(jobId: string, stage: OnboardingStage, pct: number): void {
  updateOnboardingJob(jobId, { status: 'running', stage, pct });
}

// Parse off-thread, then persist into the EXPLICIT target library. Returns the
// spec id + parsed tree (for warnings/section/title).
async function runParseAndPersist(
  jobId: string,
  buffer: Buffer,
  ext: string,
  libraryId: string,
  filename: string
): Promise<{ specId: string; tree: SpecTree }> {
  progress(jobId, 'parsing', 20);
  // The worker runs in another thread — validate its structured-clone return at
  // the boundary (Zod), mirroring parse.ts. A malformed payload throws a ZodError
  // that processOnboardingJob turns into a clean, cause-chained job failure.
  const workerRaw: unknown = await parsePool.run({ buffer, ext });
  const { tree, refs } = workerOutputSchema.parse(workerRaw) as WorkerOutput;
  progress(jobId, 'persisting', 50);
  const specId = await persistParsedSpec({
    tree,
    refs,
    libraryId,
    originMeta: buildOriginMeta(filename, buffer),
  });
  return { specId, tree };
}

// Persist the derived rules under the deterministic per-spec template name,
// idempotently: re-importing the same master upserts the spec (same id → same
// name), so a pre-existing template must be REFRESHED to the latest rules, not
// abandoned. Returns the live template id. Tries create first; a 23505 from a
// concurrent first-import is the fallback into the refresh path.
async function upsertOnboardedTemplate(
  specId: string,
  name: string,
  rules: readonly StyleRule[],
  libraryId: string
): Promise<string> {
  const existing = await getTemplateByName(name);
  if (existing) {
    await bulkUpsertTemplateRules(existing.id, rules);
    return existing.id;
  }
  try {
    // #318 — the onboarded template belongs to the spec's OWN library, not the
    // global built-in pool; otherwise every onboarded template would be a global
    // default and setSpecStyleSource's library scope could never bind it.
    const template = await createTemplateWithRules(name, null, rules, libraryId);
    return template.id;
  } catch (err) {
    // Lost a create race: another import inserted the row first. Refresh it.
    if (!pgErrorToHttp(err, { '23505': 'dup' })) throw err;
    const raced = await getTemplateByName(name);
    if (!raced) throw err;
    await bulkUpsertTemplateRules(raced.id, rules);
    return raced.id;
  }
}

// DOCX-only: derive a consensus style template (WT-3) and link it to the spec.
// Non-DOCX → nulls (the report then flags styleSourceNeeded). Re-import is
// idempotent-correct: the spec keeps ONE current template with refreshed rules.
async function deriveStyleIfDocx(
  jobId: string,
  buffer: Buffer,
  ext: string,
  specId: string,
  section: string,
  libraryId: string
): Promise<{ templateId: string | null; report: OnboardingReport['styleDerivation'] }> {
  if (ext !== '.docx') return { templateId: null, report: null };
  progress(jobId, 'deriving-style', 70);
  const analysis = await analyzeDocxStyles(buffer);
  const { rules, report } = deriveTemplate(analysis.classified, analysis.effectiveStyles);
  if (rules.length === 0) return { templateId: null, report };
  const templateId = await upsertOnboardedTemplate(
    specId,
    `onboarded:${specId}:${section}`,
    rules,
    libraryId
  );
  const assigned = await setSpecStyleSource(specId, templateId);
  // The onboarded template is created in the spec's own library, so this is
  // 'assigned' in practice — but surface any scope failure rather than silently
  // leaving the spec without its just-derived style (#318).
  if (assigned !== 'assigned') {
    throw new Error(`style-source assignment failed for onboarded spec ${specId}: ${assigned}`);
  }
  return { templateId, report };
}

// Classify editability against the library's convention profile (or the built-in
// default — reclassifySpec resolves it), then read the persisted tree back and
// summarize. reclassifySpec stores classifications; getSpecTree returns the
// effective editability per node for the summary.
async function classifyAndSummarize(
  jobId: string,
  specId: string
): Promise<Pick<OnboardingReport, 'editability' | 'hierarchy'>> {
  progress(jobId, 'classifying', 85);
  await reclassifySpec(specId, {});
  const treeResult = await getSpecTree(specId);
  if (!treeResult) throw new Error('classified spec vanished before summary');
  const source = await getSpecSource(specId);
  return {
    editability: summarizeEditability(treeResult.tree),
    hierarchy: summarizeHierarchy(treeResult.tree, source),
  };
}

async function processOnboardingJob(
  jobId: string,
  buffer: Buffer,
  ext: string,
  libraryId: string,
  filename: string
): Promise<void> {
  // Hashed once, up front, so the success child logger AND the failure catch below
  // share the same sha256 — no double-hashing (the catch fires before persist).
  const docFields = {
    filename: sanitizeFilename(filename),
    sha256: sha256Hex(buffer),
    loader: 'rest:onboarding',
    jobId,
  };
  let specId: string | undefined;
  try {
    const persisted = await runParseAndPersist(jobId, buffer, ext, libraryId, filename);
    specId = persisted.specId;
    const { tree } = persisted;
    const style = await deriveStyleIfDocx(jobId, buffer, ext, specId, tree.section, libraryId);
    const summaries = await classifyAndSummarize(jobId, specId);
    const report: OnboardingReport = {
      styleDerivation: style.report,
      styleSourceNeeded: style.templateId === null,
      editability: summaries.editability,
      hierarchy: summaries.hierarchy,
      parseWarnings: tree.warnings ?? [],
    };
    logParseWarnings(parseLog({ ...docFields, specId }), tree.warnings ?? []);
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
    // specId is set once runParseAndPersist resolves; a failure before that point
    // (e.g. worker parse error) still has no spec yet, so it is omitted.
    parseLog(specId ? { ...docFields, specId } : docFields).error({ err }, 'onboarding job failed');
    // Set the terminal stage too, so a polling client never sees status:'failed'
    // stranded on the last running stage (e.g. 'deriving-style').
    updateOnboardingJob(jobId, {
      status: 'failed',
      stage: 'failed',
      pct: 100,
      error: jobErrorMessage(err),
    });
  }
}
