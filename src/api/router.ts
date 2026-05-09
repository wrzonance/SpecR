import { type Router as RouterType, Router } from 'express';
import { healthHandler } from './health.js';
import { getSpecHandler, updateSpecHandler } from './specs.js';
import {
  createProjectHandler,
  getProjectHandler,
  addSpecToProjectHandler,
  removeSpecFromProjectHandler,
  getBrokenRefsHandler,
} from './projects.js';
import { validateBody } from './middleware/validate.js';
import {
  PatchSpecBodySchema,
  CreateProjectBodySchema,
  AddSpecToProjectBodySchema,
} from '../ast/index.js';

export const router: RouterType = Router();

router.get('/health', healthHandler);
router.get('/specs/:id', getSpecHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
router.post('/projects', validateBody(CreateProjectBodySchema), createProjectHandler);
router.get('/projects/:id', getProjectHandler);
router.post(
  '/projects/:id/specs',
  validateBody(AddSpecToProjectBodySchema),
  addSpecToProjectHandler
);
router.delete('/projects/:id/specs/:specId', removeSpecFromProjectHandler);
router.get('/projects/:id/references/broken', getBrokenRefsHandler);
