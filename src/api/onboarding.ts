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

// DOCX-only: derive a consensus style template (WT-3) and link it to the spec.
// Non-DOCX → nulls (the report then flags styleSourceNeeded). A duplicate
// template name on re-import (23505) is non-fatal — the derivation report still
// surfaces; any other DB error fails the job loudly.
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
  try {
    const template = await createTemplateWithRules(name, null, rules);
    await setSpecStyleSource(specId, template.id);
    return { templateId: template.id, report };
  } catch (err) {
    if (pgErrorToHttp(err, { '23505': 'dup' })) return { templateId: null, report };
    throw err;
  }
}

// Classify editability against the library's convention profile (or the built-in
// default — reclassifySpec resolves it), then read the persisted tree back and
// summarize. reclassifySpec stores classifications; getSpecTree returns the
// effective editability per node for the summary.
async function classifyAndSummarize(
  jobId: string,
  specId: string
): Promise<OnboardingReport['editability']> {
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
