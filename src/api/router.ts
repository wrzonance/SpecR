import { type Router as RouterType, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { healthHandler } from './health.js';
import {
  deleteSpecHandler,
  getSpecHandler,
  getSpecLineageHandler,
  getSpecTreeHandler,
  listSpecsHandler,
  updateSpecHandler,
} from './specs.js';
import { setStyleSourceHandler, clearStyleSourceHandler } from './style-source.js';
import { deleteParagraphHandler, updateParagraphHandler } from './paragraphs.js';
import { acquireLockHandler, releaseLockHandler, getLockHandler } from './locks.js';
import {
  deleteReferenceHandler,
  getInboundReferencesHandler,
  getOutboundReferencesHandler,
} from './references.js';
import {
  createProjectHandler,
  getProjectHandler,
  listProjectsHandler,
  patchProjectHandler,
  setProjectSourcesHandler,
  addSectionToProjectHandler,
  removeSectionFromProjectHandler,
  getBrokenRefsHandler,
} from './projects.js';
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
import {
  getCoordinationReportHandler,
  getPackageRequiredSectionsHandler,
  getProjectRequiredSectionsHandler,
  setPackageRequiredSectionsHandler,
  setProjectRequiredSectionsHandler,
} from './coordination.js';
import { createRevisionHandler, getRevisionHandler } from './revisions.js';
import {
  createClientLibraryHandler,
  listLibrariesHandler,
  listLibrarySpecsHandler,
  renameLibraryHandler,
} from './libraries.js';
import { validateBody } from './middleware/validate.js';
import {
  PatchSpecBodySchema,
  CreateProjectBodySchema,
  PatchProjectBodySchema,
  SetProjectSourcesBodySchema,
  AddSectionToProjectBodySchema,
  CreatePackageBodySchema,
  SetPackageSpecsBodySchema,
  SetRequiredSectionsBodySchema,
  CreateRevisionBodySchema,
  CreateTemplateBodySchema,
  PatchTemplateBodySchema,
  SetDivisionGeneralSpecBodySchema,
  UpsertStyleRulesBodySchema,
  SetStyleSourceBodySchema,
  PutRevisionNomenclatureBodySchema,
  CloneRevisionNomenclatureBodySchema,
} from '../ast/index.js';
import { parseHandler, parseJobHandler, upload } from './parse.js';
import { generateHandler, generateManualHandler, generateRevisionHandler } from './generate.js';
import { diffHandler } from './diff.js';
import { mergeHandler } from './merge.js';
import { importTemplateHandler } from './templates.js';
import {
  createTemplateHandler,
  listTemplatesHandler,
  getTemplateHandler,
  patchTemplateHandler,
  deleteTemplateHandler,
  upsertTemplateRulesHandler,
} from './templates-crud.js';
import {
  listConventionsHandler,
  getLibraryConventionHandler,
  putLibraryConventionHandler,
  cloneLibraryConventionHandler,
} from './conventions.js';
import {
  listRevisionNomenclatureProfilesHandler,
  getProjectRevisionNomenclatureHandler,
  putProjectRevisionNomenclatureHandler,
  cloneProjectRevisionNomenclatureHandler,
  deleteProjectRevisionNomenclatureHandler,
} from './revision-nomenclature.js';

const parseRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // 10 uploads per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too many requests — please wait before uploading again' },
});

export const router: RouterType = Router();

router.get('/health', healthHandler);
router.get('/libraries', listLibrariesHandler);
router.post('/libraries/clients', createClientLibraryHandler);
router.patch('/libraries/:id', renameLibraryHandler);
router.get('/libraries/:id/specs', listLibrarySpecsHandler);
router.get('/specs', listSpecsHandler);
router.get('/specs/:id', getSpecHandler);
router.get('/specs/:id/lineage', getSpecLineageHandler);
router.get('/specs/:id/tree', getSpecTreeHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
// Demo edit mutations (mockup): delete a spec, delete/edit a paragraph, delete a reference.
router.delete('/specs/:id', deleteSpecHandler);
router.delete('/specs/:id/paragraphs/:paragraphId', deleteParagraphHandler);
router.patch('/specs/:id/paragraphs/:nodeId', updateParagraphHandler);
router.delete('/specs/:id/references/:refId', deleteReferenceHandler);
router.get('/specs/:id/lock', getLockHandler);
router.put('/specs/:id/lock', acquireLockHandler);
router.delete('/specs/:id/lock', releaseLockHandler);
router.post(
  '/specs/:id/style-source',
  validateBody(SetStyleSourceBodySchema),
  setStyleSourceHandler
);
router.delete('/specs/:id/style-source', clearStyleSourceHandler);
router.post('/specs/:id/generate', generateHandler);
router.post('/specs/:id/diff', upload.single('file'), diffHandler);
router.post('/specs/:id/merge', mergeHandler);
router.get('/projects', listProjectsHandler);
router.post('/projects', validateBody(CreateProjectBodySchema), createProjectHandler);
router.get('/projects/:id', getProjectHandler);
router.post('/projects/:id/generate', generateManualHandler);
router.patch('/projects/:id', validateBody(PatchProjectBodySchema), patchProjectHandler);
router.put(
  '/projects/:id/sources',
  validateBody(SetProjectSourcesBodySchema),
  setProjectSourcesHandler
);
router.get('/projects/:id/coordination-report', getCoordinationReportHandler);
router.get('/projects/:id/required-sections', getProjectRequiredSectionsHandler);
router.put(
  '/projects/:id/required-sections',
  validateBody(SetRequiredSectionsBodySchema),
  setProjectRequiredSectionsHandler
);
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
router.get('/packages/:id/required-sections', getPackageRequiredSectionsHandler);
router.put(
  '/packages/:id/required-sections',
  validateBody(SetRequiredSectionsBodySchema),
  setPackageRequiredSectionsHandler
);
router.delete('/packages/:id', deletePackageHandler);
router.post(
  '/packages/:id/revisions',
  validateBody(CreateRevisionBodySchema),
  createRevisionHandler
);
router.get('/revisions/:id', getRevisionHandler);
router.post('/revisions/:id/generate', generateRevisionHandler);
// Mockup fixture ingest is intentionally unlimited for stakeholder demos.
router.post('/parse', upload.single('file'), parseHandler);
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
router.get('/conventions', listConventionsHandler);
router.get('/libraries/:id/conventions', getLibraryConventionHandler);
router.put('/libraries/:id/conventions', putLibraryConventionHandler);
router.post('/libraries/:id/conventions/clone', cloneLibraryConventionHandler);
router.get('/revision-nomenclature-profiles', listRevisionNomenclatureProfilesHandler);
router.get('/projects/:id/revision-nomenclature', getProjectRevisionNomenclatureHandler);
router.put(
  '/projects/:id/revision-nomenclature',
  validateBody(PutRevisionNomenclatureBodySchema),
  putProjectRevisionNomenclatureHandler
);
router.post(
  '/projects/:id/revision-nomenclature/clone',
  validateBody(CloneRevisionNomenclatureBodySchema),
  cloneProjectRevisionNomenclatureHandler
);
router.delete('/projects/:id/revision-nomenclature', deleteProjectRevisionNomenclatureHandler);
