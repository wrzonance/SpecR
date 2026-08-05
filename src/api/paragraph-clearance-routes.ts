import type { Router as RouterType } from 'express';
import { acknowledgeParagraphHandler } from './paragraph-acknowledgement.js';
import {
  patchEditabilityHandler,
  reclassifyHandler,
  acceptAsNoteHandler,
  closeCommentHandler,
} from './editability.js';

/**
 * Wires the editability/comment-resolution and readiness-finding-clearing
 * routes onto the shared router instance — extracted out of router.ts to
 * keep it under the enforced ESLint `max-lines: 400` (project override,
 * CLAUDE.md), mirroring `registerCheckpointRoutes`'s identical extraction.
 * The last two routes are new in #545 (ADR-079 follow-on) — acknowledgement
 * and comment closure, the two remaining supported paths to clear a
 * readiness finding. Registers directly on `router` (never a mounted
 * sub-router) so `expressRouteManifest`
 * (src/test-utils/contract/validate-response.js), which only walks one level
 * of `router.stack`, still sees every route.
 */
export function registerParagraphClearanceRoutes(router: RouterType): void {
  router.patch('/specs/:id/paragraphs/:nodeId/editability', patchEditabilityHandler);
  router.post('/specs/:id/reclassify', reclassifyHandler);
  router.post('/specs/:id/paragraphs/:nodeId/comments/:index/accept-as-note', acceptAsNoteHandler);
  router.patch('/specs/:id/paragraphs/:nodeId/acknowledgement', acknowledgeParagraphHandler);
  router.patch('/specs/:id/paragraphs/:nodeId/comments/:index/closure', closeCommentHandler);
}
