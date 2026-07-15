// Express app wiring for the visual round-trip verification harness (#150,
// task 6/8): mounts the run lifecycle + screenshot-ingestion routes
// (routes/runs.ts), the guarded artifact file server (routes/files.ts), and
// static UMD bundles for docx-preview + jszip — the harness's own browser
// page loads these via <script> tags, served directly out of this
// package's own node_modules (paths confirmed reachable by the WT-150
// spike) rather than bundled, since this is a local dev tool, not a shipped
// artifact (issue #150 design decision 5).
//
// createApp() is a pure factory — no process.listen(), no env loading — so
// tests mount it in-process without a real network port (see app.test.ts),
// and index.ts's boot entrypoint is the only place that calls .listen().

import path from 'node:path';
import multer from 'multer';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createRunsRouter } from './routes/runs.js';
import { createFilesRouter } from './routes/files.js';
import type { Pipeline } from '../run/pipeline.js';
import type { RunStore } from '../run/run-store.js';

export interface AppDeps {
  readonly pipeline: Pipeline;
  readonly runStore: RunStore;
}

// A full-page PNG screenshot arrives base64-encoded in a screenshot POST's
// JSON body — base64 runs ~1.33x the binary size, so a generous ceiling
// covers a tall multi-page render with headroom (express's 100kb default
// would reject almost every real screenshot).
const SCREENSHOT_JSON_LIMIT = '15mb';

// docx-preview/jszip ship UMD bundles under dist/ — resolved relative to
// this package's own root (import.meta.dirname), never the process's cwd,
// so this works identically under tsx (src/server/) and the compiled build
// (dist/server/).
const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..');

const VENDOR_BUNDLES = [
  ['/vendor/docx-preview.js', 'docx-preview/dist/docx-preview.js'],
  ['/vendor/jszip.js', 'jszip/dist/jszip.min.js'],
] as const;

function mountVendorBundles(app: Express): void {
  for (const [routePath, moduleRelativePath] of VENDOR_BUNDLES) {
    const absolutePath = path.join(PACKAGE_ROOT, 'node_modules', moduleRelativePath);
    app.get(routePath, (_req, res) => {
      // { dotfiles: 'allow' }: express's `send` 404s any path with a
      // dot-prefixed ANCESTOR segment by default — both a repo checked out
      // into a git worktree (.worktrees/...) and pnpm's own .pnpm/ symlink
      // target trip that heuristic, even though `absolutePath` here is a
      // fixed, hardcoded module path with no user input in it at all.
      res.sendFile(absolutePath, { dotfiles: 'allow' });
    });
  }
}

function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'not found' });
}

// Express recognizes error-handling middleware by arity (four params), so
// _req/_next stay in the signature even though this handler never reads
// them — mirrors src/api/middleware/error.ts's errorHandler. Never forwards
// err.message/stack to the response body: this harness has no logger of its
// own (isolated package), so the only visibility into an unexpected failure
// is the response status this middleware controls.
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  res.status(500).json({ success: false, error: 'internal server error' });
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: SCREENSHOT_JSON_LIMIT }));

  app.use('/api/runs', createRunsRouter(deps.pipeline, deps.runStore));
  app.use('/api/runs', createFilesRouter(deps.runStore));

  mountVendorBundles(app);
  app.use(express.static(path.join(PACKAGE_ROOT, 'public')));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
