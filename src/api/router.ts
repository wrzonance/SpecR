import { type Router as RouterType, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { healthHandler } from './health.js';
import { getSpecHandler, getSpecLineageHandler, updateSpecHandler } from './specs.js';
import {
  createProjectHandler,
  getProjectHandler,
  addSectionToProjectHandler,
  removeSectionFromProjectHandler,
  getBrokenRefsHandler,
} from './projects.js';
import { getInboundReferencesHandler, getOutboundReferencesHandler } from './references.js';
import {
  getLibraryDivisionGeneralSpecHandler,
  setLibraryDivisionGeneralSpecHandler,
  getProjectDivisionGeneralSpecHandler,
  setProjectDivisionGeneralSpecHandler,
} from './division-general.js';
import {
  createPackageHandler,
  listPackagesHandler,
  setPackageSpecsHandler,
  deletePackageHandler,
} from './packages.js';
import { createRevisionHandler, getRevisionHandler } from './revisions.js';
import { validateBody } from './middleware/validate.js';
import {
  PatchSpecBodySchema,
  CreateProjectBodySchema,
  AddSectionToProjectBodySchema,
  CreatePackageBodySchema,
  SetPackageSpecsBodySchema,
  CreateRevisionBodySchema,
  CreateTemplateBodySchema,
  PatchTemplateBodySchema,
  UpsertStyleRulesBodySchema,
  SetDivisionGeneralSpecBodySchema,
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
router.get('/specs/:id/lineage', getSpecLineageHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
router.post('/specs/:id/generate', generateHandler);
router.post('/projects', validateBody(CreateProjectBodySchema), createProjectHandler);
router.get('/projects/:id', getProjectHandler);
router.get(
  '/libraries/:libraryId/divisions/:division/general-spec',
  getLibraryDivisionGeneralSpecHandler
);
router.put(
  '/libraries/:libraryId/divisions/:division/general-spec',
  validateBody(SetDivisionGeneralSpecBodySchema),
  setLibraryDivisionGeneralSpecHandler
);
router.get(
  '/projects/:projectId/divisions/:division/general-spec',
  getProjectDivisionGeneralSpecHandler
);
router.put(
  '/projects/:projectId/divisions/:division/general-spec',
  validateBody(SetDivisionGeneralSpecBodySchema),
  setProjectDivisionGeneralSpecHandler
);
router.post(
  '/projects/:id/specs',
  validateBody(AddSectionToProjectBodySchema),
  addSectionToProjectHandler
);
router.delete('/projects/:id/specs/:specId', removeSectionFromProjectHandler);
router.get('/projects/:id/references/broken', getBrokenRefsHandler);
router.get('/projects/:id/references/inbound', getInboundReferencesHandler);
router.get('/projects/:id/specs/:specId/references', getOutboundReferencesHandler);
router.post('/projects/:id/packages', validateBody(CreatePackageBodySchema), createPackageHandler);
router.get('/projects/:id/packages', listPackagesHandler);
router.put('/packages/:id/specs', validateBody(SetPackageSpecsBodySchema), setPackageSpecsHandler);
router.delete('/packages/:id', deletePackageHandler);
router.post(
  '/packages/:id/revisions',
  validateBody(CreateRevisionBodySchema),
  createRevisionHandler
);
router.get('/revisions/:id', getRevisionHandler);
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
