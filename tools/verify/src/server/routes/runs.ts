// HTTP routes for starting/polling verification runs and ingesting
// externally-captured screenshots (#150, task 6/8).
//
// POST /api/runs starts a new run: multipart upload of the reference DOCX
// (plus optional section/title/sectionNumberFormat text fields) wired
// straight onto run/pipeline.ts's fire-and-forget startRun() — this route
// only adapts the multipart request into StartRunInput and returns the
// runId immediately; poll progress via GET /api/runs/:runId.
//
// POST /api/runs/:runId/screenshot is the PRIMARY (not alternative)
// capture-ingestion path per issue #150's resolved capture-source decision
// (WT-150 spike finding 1): the driving agent (Playwright) takes a
// full-page screenshot of the harness's reference/roundtrip pane
// *externally* and POSTs it here as base64 PNG.
// window.__captureScreenshot() (in-page canvas/foreignObject rasterization)
// is confirmed non-viable by that spike and is not this route's concern.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Router, type Request, type Response } from 'express';
import * as z from 'zod';
import { SectionNumberFormatSchema } from '../../api-client/schemas.js';
import { stringParam } from '../params.js';
import type { Pipeline } from '../../run/pipeline.js';
import type { RunStore } from '../../run/run-store.js';

// Mirrors the SpecR API's own compressed-upload limit exactly
// (src/api/parse.ts's multer config) — this harness re-uploads the same
// reference file to two endpoints (/parse and /templates/import), never
// re-compressing it, so it never needs to accept more than the API itself
// ever will. (Deliberately sized, not left at multer's unbounded default —
// see this file's eslint.config.js override for sonarjs/content-length,
// whose default 8 MB threshold this exceeds.)
const MAX_REFERENCE_DOCX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_REFERENCE_DOCX_BYTES, files: 1, fields: 5, fieldSize: 1024 },
});

const StartRunBodySchema = z.object({
  section: z.string().exactOptional(),
  title: z.string().exactOptional(),
  sectionNumberFormat: SectionNumberFormatSchema.exactOptional(),
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SubmitScreenshotBodySchema = z.object({
  pane: z.enum(['reference', 'roundtrip']),
  imageBase64: z.string().min(1),
});

function screenshotFilename(pane: 'reference' | 'roundtrip'): string {
  return pane === 'reference' ? 'reference-screenshot.png' : 'roundtrip-screenshot.png';
}

// Buffer.from(str, 'base64') never throws on malformed base64 (it decodes
// what it can and silently drops the rest) — the PNG-signature check is
// therefore the real validation here, not a try/catch.
function decodePng(imageBase64: string): Buffer | null {
  const buffer = Buffer.from(imageBase64, 'base64');
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ? buffer : null;
}

function startRunHandler(pipeline: Pipeline) {
  return (req: Request, res: Response): void => {
    if (!req.file) {
      res.status(422).json({ success: false, error: 'file is required' });
      return;
    }
    const bodyResult = StartRunBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(422).json({ success: false, error: 'invalid run start request body' });
      return;
    }
    const runId = pipeline.startRun({
      referenceBuffer: req.file.buffer,
      referenceFilename: req.file.originalname,
      options: bodyResult.data,
    });
    res.status(202).json({ success: true, data: { runId } });
  };
}

function getRunHandler(runStore: RunStore) {
  return (req: Request, res: Response): void => {
    const runId = stringParam(req.params['runId']);
    const record = runId === undefined ? undefined : runStore.getRun(runId);
    if (record === undefined) {
      res.status(404).json({ success: false, error: 'run not found' });
      return;
    }
    res.status(200).json({ success: true, data: record });
  };
}

function writeScreenshot(
  runStore: RunStore,
  runId: string,
  pane: 'reference' | 'roundtrip',
  buffer: Buffer
): ReturnType<RunStore['updateRun']> {
  const filename = screenshotFilename(pane);
  const destPath = path.join(runStore.runDir(runId), filename);
  writeFileSync(destPath, buffer);

  const artifacts =
    pane === 'reference'
      ? { referenceScreenshotPath: destPath }
      : { roundtripScreenshotPath: destPath };
  return runStore.updateRun(runId, { stage: 'screenshot', status: 'running', artifacts });
}

function submitScreenshotHandler(runStore: RunStore) {
  return (req: Request, res: Response): void => {
    const runId = stringParam(req.params['runId']);
    const record = runId === undefined ? undefined : runStore.getRun(runId);
    if (record === undefined) {
      res.status(404).json({ success: false, error: 'run not found' });
      return;
    }

    const bodyResult = SubmitScreenshotBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(422).json({ success: false, error: 'invalid screenshot request body' });
      return;
    }

    const buffer = decodePng(bodyResult.data.imageBase64);
    if (buffer === null) {
      res.status(422).json({ success: false, error: 'imageBase64 is not a valid PNG' });
      return;
    }

    const updated = writeScreenshot(runStore, record.runId, bodyResult.data.pane, buffer);
    res.status(200).json({ success: true, data: updated });
  };
}

export function createRunsRouter(pipeline: Pipeline, runStore: RunStore): Router {
  const router = Router();
  router.post('/', upload.single('file'), startRunHandler(pipeline));
  router.get('/:runId', getRunHandler(runStore));
  router.post('/:runId/screenshot', submitScreenshotHandler(runStore));
  return router;
}
