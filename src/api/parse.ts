import multer from 'multer';
import path from 'node:path';
import type { Request, Response } from 'express';
import { parseSec, parseDocx, assertDocxSafe, assertSecSafe } from '../parser/index.js';
import { createJob, updateJob, getJob, type ParseStage } from '../lib/jobs.js';
import { pool, createSpec, insertTree } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { CsiNode, CsiTree } from '../ast/types.js';

interface ParseBody {
  readonly section?: string;
  readonly title?: string;
}

function parseBody(raw: unknown): ParseBody {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    ...(typeof r['section'] === 'string' ? { section: r['section'] } : {}),
    ...(typeof r['title'] === 'string' ? { title: r['title'] } : {}),
  };
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_EXT = new Set(['.docx', '.sec']);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB compressed limit (yauzl enforces uncompressed)
    files: 1,
    fields: 5,
    fieldSize: 1024,
  },
});

async function validateUpload(req: Request, ext: string): Promise<string | null> {
  if (!ALLOWED_EXT.has(ext)) return 'unsupported file extension';
  if (ext === '.docx' && req.file?.mimetype !== DOCX_MIME) return 'MIME type mismatch for .docx';
  try {
    if (ext === '.docx') await assertDocxSafe(req.file!.buffer);
    else assertSecSafe(req.file!.buffer);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid file';
  }
}

export async function parseHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const validationError = await validateUpload(req, ext);
  if (validationError !== null) {
    res.status(400).json({ success: false, error: validationError });
    return;
  }

  const jobId = createJob();
  // Pass buffer and ext, not the full file object, so the request closure can be GC'd
  void processParseJob(jobId, req.file.buffer, ext, parseBody(req.body));
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

function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

async function persistTree(tree: CsiTree): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = tree.parts[0]?.meta.source ?? 'unknown';
    const specId = await createSpec({ section: tree.section, title: tree.title, source }, client);
    const treeWithId: CsiTree = { ...tree, id: specId };
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

async function processParseJob(
  jobId: string,
  buffer: Buffer,
  ext: string,
  body: ParseBody
): Promise<void> {
  try {
    const onProgress = (stage: string, pct: number): void => {
      updateJob(jobId, { stage: stage as ParseStage, pct, status: 'running' });
    };

    let tree: CsiTree;
    if (ext === '.sec') {
      onProgress('extracting', 10);
      tree = parseSec(assertSecSafe(buffer)).tree;
      onProgress('classifying', 75);
    } else {
      tree = await parseDocx(buffer, onProgress);
    }

    const finalTree: CsiTree = {
      ...tree,
      ...(body.section ? { section: body.section } : {}),
      ...(body.title ? { title: body.title } : {}),
    };

    updateJob(jobId, { stage: 'persisting', pct: 90, status: 'running' });
    const specId = await persistTree(finalTree);
    const nodeCount = countNodes(finalTree.parts);

    updateJob(jobId, {
      status: 'complete',
      stage: 'complete',
      pct: 100,
      result: { specId, section: finalTree.section, title: finalTree.title, nodeCount },
    });
  } catch (err) {
    logger.error({ err, jobId }, 'parse job failed');
    updateJob(jobId, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'parse failed',
    });
  }
}
