import { type Router as RouterType, Router } from 'express';
import rateLimit from 'express-rate-limit';
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
  CreateTemplateBodySchema,
  PatchTemplateBodySchema,
  UpsertStyleRulesBodySchema,
} from '../ast/index.js';
import { parseHandler, parseJobHandler, upload } from './parse.js';
import { generateHandler } from './generate.js';
import { importTemplateHandler } from './templates.js';
import {
  createTemplateHandler,
  listTemplatesHandler,
  getTemplateHandler,
  patchTemplateHandler,
  deleteTemplateHandler,
  upsertTemplateRulesHandler,
} from './templates-crud.js';

const parseRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // 10 uploads per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too many requests — please wait before uploading again' },
});

export const router: RouterType = Router();

router.get('/health', healthHandler);
router.get('/specs/:id', getSpecHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
router.post('/specs/:id/generate', generateHandler);
router.post('/projects', validateBody(CreateProjectBodySchema), createProjectHandler);
router.get('/projects/:id', getProjectHandler);
router.post(
  '/projects/:id/specs',
  validateBody(AddSpecToProjectBodySchema),
  addSpecToProjectHandler
);
router.delete('/projects/:id/specs/:specId', removeSpecFromProjectHandler);
router.get('/projects/:id/references/broken', getBrokenRefsHandler);
router.post('/parse', parseRateLimit, upload.single('file'), parseHandler);
router.get('/parse/jobs/:jobId', parseJobHandler);
router.post('/templates/import', parseRateLimit, upload.single('file'), importTemplateHandler);
router.post('/templates', validateBody(CreateTemplateBodySchema), createTemplateHandler);
router.get('/templates', listTemplatesHandler);
router.get('/templates/:id', getTemplateHandler);
router.patch('/templates/:id', validateBody(PatchTemplateBodySchema), patchTemplateHandler);
router.delete('/templates/:id', deleteTemplateHandler);
router.post(
  '/templates/:id/rules',
  validateBody(UpsertStyleRulesBodySchema),
  upsertTemplateRulesHandler
);
