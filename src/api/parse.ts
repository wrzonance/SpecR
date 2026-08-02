import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { assertDocxSafe, assertPdfSafe, assertSecSafe } from '../parser/index.js';
import { createJob, updateJob, getJob, type ParseStage } from '../lib/jobs.js';
import { parsePool } from '../lib/parse-pool.js';
import { workerOutputSchema, type WorkerOutput } from '../lib/parse-worker.js';
import { persistParsedSpec, getNumberingProfile } from '../db/index.js';
import type { OriginMeta } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { parseLog, logParseWarnings } from '../lib/log-context.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import type { SpecNode, SpecTree } from '../ast/types.js';
import type { NumberingProfile } from '../ast/index.js';
import { parseSectionNumberCandidate } from '../lib/section-number.js';
import { ALLOWED_PARSE_EXTENSIONS } from '../lib/parse-extensions.js';

interface ParseBody {
  readonly section?: string;
  readonly title?: string;
  readonly numberingProfileId?: string;
}

// Multipart text fields from multer. Non-strict (unknown keys stripped) to
// match PatchSpecBodySchema; non-string section/title is a 400, not a silent drop.
const ParseBodySchema = z.object({
  section: z.string().exactOptional(),
  title: z.string().exactOptional(),
  // Optional structural numbering profile to apply during this parse (#299).
  // Absent ⇒ no profile ⇒ byte-for-byte today's behavior (no default injected).
  numberingProfileId: z.uuid().exactOptional(),
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const ALLOWED_EXT = ALLOWED_PARSE_EXTENSIONS;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // sonarjs/content-length is a security *hotspot*: it flags the limit for human
    // review rather than detecting a missing one. Reviewed — 10 MB compressed is
    // deliberate, and decompression-bomb protection for the *uncompressed* size
    // lives in assertUploadSafe/assertDocxSafe (yauzl), not here.
    // eslint-disable-next-line sonarjs/content-length
    fileSize: 10 * 1024 * 1024, // 10 MB compressed limit (yauzl enforces uncompressed)
    files: 1,
    fields: 5,
    fieldSize: 1024,
  },
});

type UploadValidation = { error: string } | { file: Express.Multer.File; ext: string };

function uploadMimeError(ext: string, mimetype: string): string | null {
  if (ext === '.docx' && mimetype !== DOCX_MIME) return 'MIME type mismatch for .docx';
  if (ext === '.pdf' && mimetype !== PDF_MIME) return 'MIME type mismatch for .pdf';
  return null;
}

async function assertUploadSafe(ext: string, buffer: Buffer): Promise<void> {
  if (ext === '.docx') {
    await assertDocxSafe(buffer);
    return;
  }
  if (ext === '.pdf') {
    assertPdfSafe(buffer);
    return;
  }
  assertSecSafe(buffer);
}

async function validateUpload(req: Request): Promise<UploadValidation> {
  if (!req.file) return { error: 'file required' };
  const file = req.file;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { error: 'unsupported file extension' };
  const mimeError = uploadMimeError(ext, file.mimetype);
  if (mimeError !== null) return { error: mimeError };
  if (ext === '.txt') return { file, ext };
  try {
    await assertUploadSafe(ext, file.buffer);
    return { file, ext };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid file' };
  }
}

// Resolve the optional assigned numbering profile (#299) before the job starts,
// so a missing profile is a synchronous 404 rather than a failed async job.
// Returns the profile's rules; `undefined` when none was requested; `null` after
// a 404/500 was sent (the caller must stop). Application happens at parse time —
// SpecR stores no source DOCX to re-apply a profile against later (ADR-021).
async function resolveRequestedProfile(
  profileId: string | undefined,
  res: Response
): Promise<NumberingProfile | null | undefined> {
  if (profileId === undefined) return undefined;
  try {
    const profile = await getNumberingProfile(profileId);
    if (!profile) {
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return null;
    }
    return profile.rules;
  } catch (err) {
    logger.error({ err }, 'numbering profile lookup failed');
    res.status(500).json({ success: false, error: 'internal server error' });
    return null;
  }
}

// Validate + canonicalize the optional section override. Returns the canonical
// section, `undefined` when none was given, or `null` after sending a 400.
function resolveSectionOverride(raw: string | undefined, res: Response): string | null | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseSectionNumberCandidate(raw, 'strong');
  if (parsed?.ok !== true) {
    res.status(400).json({ success: false, error: 'invalid section override format' });
    return null;
  }
  return parsed.canonical;
}

export async function parseHandler(req: Request, res: Response): Promise<void> {
  const validation = await validateUpload(req);
  if ('error' in validation) {
    res.status(400).json({ success: false, error: validation.error });
    return;
  }
  const { file, ext } = validation;

  const bodyResult = ParseBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid request body' });
    return;
  }
  const rawBody: ParseBody = bodyResult.data;
  const section = resolveSectionOverride(rawBody.section, res);
  if (section === null) return; // 400 already sent
  const numberingProfile = await resolveRequestedProfile(rawBody.numberingProfileId, res);
  if (numberingProfile === null) return; // 404/500 already sent

  const body: ParseBody = { ...rawBody, ...(section !== undefined ? { section } : {}) };

  const jobId = createJob();
  // Pass buffer and ext, not the full file object, so the request closure can be GC'd
  void processParseJob(jobId, file.buffer, ext, body, file.originalname, numberingProfile);
  res.status(202).json({ success: true, data: { jobId } });
}

export function parseJobHandler(req: Request, res: Response): void {
  const jobId = req.params['jobId'];
  if (!jobId || typeof jobId !== 'string') {
    res.status(400).json({ success: false, error: 'missing jobId' });
    return;
  }
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'job not found' });
    return;
  }
  res.status(200).json({ success: true, data: job });
}

function countNodes(nodes: readonly SpecNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

const SECTION_GATE_MESSAGE =
  'parsed section number is not a valid CSI section (expected NN NN NN[.NN[ NN]])';

// A worker-output section that fails the gate surfaces as a raw Zod issue blob.
// Translate that one case to a human-readable message; everything else keeps its
// original error text (still context-chained via SpecrError where applicable).
function jobErrorMessage(err: unknown): string {
  if (err instanceof z.ZodError && err.issues.some((i) => i.path.includes('section'))) {
    return SECTION_GATE_MESSAGE;
  }
  return err instanceof Error ? err.message : 'parse failed';
}

function buildOriginMeta(filename: string, buffer: Buffer): OriginMeta {
  return { filename: sanitizeFilename(filename), sha256: sha256Hex(buffer), loader: 'rest:parse' };
}

// Run the parse worker over the Piscina boundary and validate its structured-clone
// return. Buffer from multer may reference a shared pool — structured clone (no
// transferList) is safe. An assigned numbering profile (#299) is forwarded only
// when present, so the no-profile call shape is byte-for-byte unchanged.
async function runParseWorker(
  buffer: Buffer,
  ext: string,
  numberingProfile?: NumberingProfile
): Promise<WorkerOutput> {
  const workerRaw: unknown = await parsePool.run({
    buffer,
    ext,
    ...(numberingProfile !== undefined ? { numberingProfile } : {}),
  });
  return workerOutputSchema.parse(workerRaw) as WorkerOutput;
}

async function processParseJob(
  jobId: string,
  buffer: Buffer,
  ext: string,
  body: ParseBody,
  filename: string,
  numberingProfile?: NumberingProfile
): Promise<void> {
  // Computed once, up front, so both persistParsedSpec and the child logger
  // (success AND failure paths below) share the same sha256 — no double-hashing.
  const originMeta = buildOriginMeta(filename, buffer);
  try {
    const onProgress = (stage: string, pct: number): void => {
      updateJob(jobId, { stage: stage as ParseStage, pct, status: 'running' });
    };

    onProgress('extracting', 10);
    const { tree, refs, capabilities } = await runParseWorker(buffer, ext, numberingProfile);
    onProgress('classifying', 75);

    const finalTree: SpecTree = {
      ...tree,
      ...(body.section ? { section: body.section } : {}),
      ...(body.title ? { title: body.title } : {}),
    };

    updateJob(jobId, { stage: 'persisting', pct: 90, status: 'running' });
    const specId = await persistParsedSpec({ tree: finalTree, refs, originMeta });
    const nodeCount = countNodes(finalTree.parts);
    logParseWarnings(parseLog({ ...originMeta, jobId, specId }), finalTree.warnings ?? []);

    updateJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: {
        specId,
        section: finalTree.section,
        title: finalTree.title,
        nodeCount,
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(finalTree.warnings !== undefined ? { warnings: finalTree.warnings } : {}),
      },
    });
  } catch (err) {
    parseLog({ ...originMeta, jobId }).error({ err }, 'parse job failed');
    updateJob(jobId, {
      status: 'failed',
      error: jobErrorMessage(err),
    });
  }
}
