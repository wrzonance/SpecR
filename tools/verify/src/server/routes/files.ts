// Guarded file-serving route for the visual round-trip verification harness
// (#150, task 6/8): GET /api/runs/:runId/files/:filename serves the two
// round-tripped DOCX files, the manifest, the externally-captured
// screenshots, and every region crop/diff a run produces (see
// diff/pixel-diff.ts's `${regionName}-reference|roundtrip|diff.png` naming).
//
// resolveRunFilePath is the safety boundary this route rests on, layered
// per filename.ts's own stated defense-in-depth rationale:
//   1. `filename` must match FileNameParamSchema's CLOSED enum — the exact
//      set of artifact names run-store.ts/pixel-diff.ts ever write.
//   2. `runId` must survive sanitizeRunFilename (filename.ts) — the same
//      traversal guard the file-serving route's own docstring anticipates.
//   3. `runId` must name a run that actually exists in `runStore` — an
//      unrecognized/never-created runId (including any traversal-shaped
//      string, which can never equal a real randomUUID()) resolves to null
//      before touching the filesystem.
//   4. A final containment check confirms the resolved path never escapes
//      that run's own directory — a backstop, not the primary guard.
// Any filename that fails ANY layer resolves to null, and the route answers
// a generic 404 — never a distinguishing message between "run doesn't
// exist", "filename not recognized", and "file not yet produced", and never
// a filesystem read outside the run's sandbox.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import * as z from 'zod';
import { sanitizeRunFilename } from '../../filename.js';
import { stringParam } from '../params.js';
import type { RunStore } from '../../run/run-store.js';

export const RUN_FILE_NAMES = [
  'reference.docx',
  'generated.docx',
  'manifest.json',
  'reference-screenshot.png',
  'roundtrip-screenshot.png',
  'page-reference.png',
  'page-roundtrip.png',
  'page-diff.png',
  'header-reference.png',
  'header-roundtrip.png',
  'header-diff.png',
  'footer-reference.png',
  'footer-roundtrip.png',
  'footer-diff.png',
] as const;

export const FileNameParamSchema = z.enum(RUN_FILE_NAMES);

function safeRunId(runId: string): string | null {
  try {
    return sanitizeRunFilename(runId);
  } catch {
    return null;
  }
}

function isWithin(runDir: string, resolved: string): boolean {
  const relative = path.relative(runDir, resolved);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolve `filename` to an absolute path inside `runId`'s work directory, or
 * null if `runId`/`filename` fails any layer of this module's docstring.
 * Never mutates `runStore` — a pure lookup + string-join, safe to call from
 * a route handler on every request.
 */
export function resolveRunFilePath(
  runStore: RunStore,
  runId: string,
  filename: string
): string | null {
  const filenameResult = FileNameParamSchema.safeParse(filename);
  if (!filenameResult.success) return null;

  const cleanRunId = safeRunId(runId);
  if (cleanRunId === null || runStore.getRun(cleanRunId) === undefined) return null;

  const runDir = runStore.runDir(cleanRunId);
  const resolved = path.join(runDir, filenameResult.data);
  return isWithin(runDir, resolved) ? resolved : null;
}

function serveRunFile(runStore: RunStore) {
  return (req: Request, res: Response): void => {
    const runId = stringParam(req.params['runId']);
    const filename = stringParam(req.params['filename']);
    const resolved =
      runId === undefined || filename === undefined
        ? null
        : resolveRunFilePath(runStore, runId, filename);

    if (resolved === null || !existsSync(resolved)) {
      res.status(404).json({ success: false, error: 'run file not found' });
      return;
    }
    // { dotfiles: 'allow' }: express's `send` 404s any path with a
    // dot-prefixed ANCESTOR segment by default (e.g. a repo checked out
    // into a git worktree at .worktrees/..., or pnpm's .pnpm/ symlink
    // target) — nothing to do with the requested filename itself, which
    // `resolved` has already fully validated (closed enum +
    // sanitizeRunFilename + containment check, this module's docstring).
    // Disabling that heuristic here doesn't open a new hole; it stops it
    // misfiring on a path this route has already proven safe.
    res.sendFile(resolved, { dotfiles: 'allow' });
  };
}

export function createFilesRouter(runStore: RunStore): Router {
  const router = Router();
  router.get('/:runId/files/:filename', serveRunFile(runStore));
  return router;
}
