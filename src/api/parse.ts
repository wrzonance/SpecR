import multer from 'multer';
import path from 'node:path';
import type { Request, Response } from 'express';
import { parseSec, parseDocx } from '../parser/index.js';
import { createJob, updateJob, getJob, type ParseStage } from '../lib/jobs.js';
import { pool, createSpec, insertTree } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { CsiNode, CsiTree } from '../ast/types.js';

// SECURITY (issue #19): validate MIME type — .docx must match
// application/vnd.openxmlformats-officedocument.wordprocessingml.document
// AND magic bytes PK\x03\x04. Reject mismatch before processing.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

export function parseHandler(req: Request, res: Response): void {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }
  const jobId = createJob();
  const body = req.body as { section?: string; title?: string };
  void processParseJob(jobId, req.file, body);
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
  file: Express.Multer.File,
  body: { section?: string; title?: string }
): Promise<void> {
  try {
    const ext = path.extname(file.originalname).toLowerCase();
    const onProgress = (stage: string, pct: number): void => {
      updateJob(jobId, { stage: stage as ParseStage, pct, status: 'running' });
    };

    let tree: CsiTree;
    if (ext === '.sec') {
      onProgress('extracting', 10);
      const parsed = parseSec(file.buffer.toString('utf-8'));
      tree = parsed.tree;
      onProgress('classifying', 75);
    } else if (ext === '.docx') {
      tree = await parseDocx(file.buffer, onProgress);
    } else {
      updateJob(jobId, { status: 'failed', error: `unsupported format: ${ext || '(none)'}` });
      return;
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
