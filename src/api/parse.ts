import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { assertDocxSafe, assertSecSafe } from '../parser/index.js';
import { createJob, updateJob, getJob, type ParseStage } from '../lib/jobs.js';
import { parsePool } from '../lib/parse-pool.js';
import type { WorkerOutput } from '../lib/parse-worker.js';
import { persistParsedSpec } from '../db/index.js';
import type { OriginMeta } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sha256Hex } from '../lib/hash.js';
import { sanitizeFilename } from '../lib/filename.js';
import type { SpecNode, SpecTree } from '../ast/types.js';
import { ParseWarningSchema, SecRefSchema } from '../ast/schemas.js';
import { SectionNumberSchema, normalizeSectionNumber } from '../lib/section-number.js';

interface ParseBody {
  readonly section?: string;
  readonly title?: string;
  readonly libraryId?: string;
}

// Multipart text fields from multer. Non-strict (unknown keys stripped) to
// match PatchSpecBodySchema; non-string section/title is a 400, not a silent drop.
const ParseBodySchema = z.object({
  section: z.string().exactOptional(),
  title: z.string().exactOptional(),
  libraryId: z.uuid().exactOptional(),
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_EXT = new Set(['.docx', '.sec', '.txt']);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB compressed limit (yauzl enforces uncompressed)
    files: 1,
    fields: 5,
    fieldSize: 1024,
  },
});

type UploadValidation = { error: string } | { file: Express.Multer.File; ext: string };

async function validateUpload(req: Request): Promise<UploadValidation> {
  if (!req.file) return { error: 'file required' };
  const file = req.file;
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { error: 'unsupported file extension' };
  if (ext === '.txt') return { file, ext }; // plaintext: no archive or XML validation needed
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
  const normalizedSection =
    rawBody.section !== undefined ? normalizeSectionNumber(rawBody.section) : undefined;
  if (rawBody.section !== undefined && normalizedSection === null) {
    res.status(400).json({ success: false, error: 'invalid section override format' });
    return;
  }
  const body: ParseBody = {
    ...rawBody,
    ...(normalizedSection != null ? { section: normalizedSection } : {}),
  };

  const jobId = createJob();
  // Pass buffer and ext, not the full file object, so the request closure can be GC'd
  void processParseJob(jobId, file.buffer, ext, body, file.originalname);
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

const workerOutputSchema = z.object({
  tree: z.object({
    id: z.string(),
    section: z.union([SectionNumberSchema, z.literal('unknown')]),
    title: z.string(),
    parts: z.array(z.unknown()),
    warnings: z.array(ParseWarningSchema).optional(),
  }),
  refs: z.array(SecRefSchema).default([]),
  capabilities: z.array(z.string()).optional(),
});

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

async function processParseJob(
  jobId: string,
  buffer: Buffer,
  ext: string,
  body: ParseBody,
  filename: string
): Promise<void> {
  try {
    const onProgress = (stage: string, pct: number): void => {
      updateJob(jobId, { stage: stage as ParseStage, pct, status: 'running' });
    };

    onProgress('extracting', 10);
    // Buffer from multer may reference a shared pool — structured clone (no transferList) is safe.
    const workerRaw: unknown = await parsePool.run({ buffer, ext });
    const { tree, refs, capabilities } = workerOutputSchema.parse(workerRaw) as WorkerOutput;
    onProgress('classifying', 75);

    const finalTree: SpecTree = {
      ...tree,
      ...(body.section ? { section: body.section } : {}),
      ...(body.title ? { title: body.title } : {}),
    };

    updateJob(jobId, { stage: 'persisting', pct: 90, status: 'running' });
    const specId = await persistParsedSpec({
      tree: finalTree,
      refs,
      originMeta: buildOriginMeta(filename, buffer),
      ...(body.libraryId ? { libraryId: body.libraryId } : {}),
    });
    const nodeCount = countNodes(finalTree.parts);

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
    logger.error({ err, jobId }, 'parse job failed');
    updateJob(jobId, {
      status: 'failed',
      error: jobErrorMessage(err),
    });
  }
}
