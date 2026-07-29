import type { Router as RouterType } from 'express';
import {
  createSpecCheckpointHandler,
  listSpecCheckpointsHandler,
  createProjectCheckpointHandler,
  listProjectCheckpointsHandler,
  getCheckpointHandler,
} from './checkpoints.js';
import {
  getSpecPendingSummaryHandler,
  getProjectPendingSummaryHandler,
} from './pending-summary.js';
import { rejectParagraphHandler } from './paragraph-reject.js';

/**
 * Wires the version-history checkpoint, pending-summary, and per-paragraph
 * reject routes (ADR-052 D3/D4/D9, issue #380 task 9) onto the shared router
 * instance — extracted out of router.ts to keep it under the enforced
 * ESLint `max-lines: 400` (project override, CLAUDE.md). Registers directly
 * on `router` (never a mounted sub-router) so `expressRouteManifest`
 * (src/test-utils/contract/validate-response.js), which only walks one level
 * of `router.stack`, still sees every route.
 */
export function registerCheckpointRoutes(router: RouterType): void {
  router.post('/specs/:id/checkpoints', createSpecCheckpointHandler);
  router.get('/specs/:id/checkpoints', listSpecCheckpointsHandler);
  router.post('/projects/:id/checkpoints', createProjectCheckpointHandler);
  router.get('/projects/:id/checkpoints', listProjectCheckpointsHandler);
  router.get('/checkpoints/:id', getCheckpointHandler);
  router.get('/specs/:id/pending-summary', getSpecPendingSummaryHandler);
  router.get('/projects/:id/pending-summary', getProjectPendingSummaryHandler);
  router.patch('/specs/:id/paragraphs/:nodeId/reject', rejectParagraphHandler);
}
