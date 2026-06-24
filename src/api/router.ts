import { type Router as RouterType, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { healthHandler } from './health.js';
import { getSpecHandler, getSpecLineageHandler, updateSpecHandler } from './specs.js';
import { setStyleSourceHandler, clearStyleSourceHandler } from './style-source.js';
import { updateParagraphHandler } from './paragraphs.js';
import { acquireLockHandler, releaseLockHandler, getLockHandler } from './locks.js';
import {
  createProjectHandler,
  listProjectsHandler,
  getProjectHandler,
  setProjectSourcesHandler,
  patchProjectHandler,
  deleteProjectHandler,
  restoreProjectHandler,
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
  SetStyleSourceBodySchema,
  SetDivisionGeneralSpecBodySchema,
  PutRevisionNomenclatureBodySchema,
  CloneRevisionNomenclatureBodySchema,
  RequiredSectionsBodySchema,
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
  listLibrariesHandler,
  listLibrarySpecsHandler,
  createClientLibraryHandler,
  renameLibraryHandler,
} from './libraries.js';
import { importLibraryHandler, importJobHandler } from './onboarding.js';
import { finalizeSpecHandler, reopenSpecHandler } from './onboarding-status.js';
import {
  listRevisionNomenclatureProfilesHandler,
  getProjectRevisionNomenclatureHandler,
  putProjectRevisionNomenclatureHandler,
  cloneProjectRevisionNomenclatureHandler,
  deleteProjectRevisionNomenclatureHandler,
} from './revision-nomenclature.js';
import {
  listBaselineRequiredSectionsHandler,
  putBaselineRequiredSectionsHandler,
  listPackageRequiredSectionsHandler,
  putPackageRequiredSectionsHandler,
} from './required-sections.js';
import { getCoordinationReportHandler } from './coordination.js';
import { getSpecOpenCommentsHandler, getProjectOpenCommentsHandler } from './open-comments.js';
import { patchEditabilityHandler, reclassifyHandler, acceptAsNoteHandler } from './editability.js';
import {
  createAssociationHandler,
  listAssociationsHandler,
  deleteAssociationHandler,
} from './associations.js';

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
router.get('/specs/:id/open-comments', getSpecOpenCommentsHandler);
router.get('/specs/:id/lineage', getSpecLineageHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
router.patch('/specs/:id/paragraphs/:nodeId', updateParagraphHandler);
router.patch('/specs/:id/paragraphs/:nodeId/editability', patchEditabilityHandler);
router.post('/specs/:id/reclassify', reclassifyHandler);
router.post('/specs/:id/finalize', finalizeSpecHandler);
router.post('/specs/:id/reopen', reopenSpecHandler);
router.post('/specs/:id/paragraphs/:nodeId/comments/:index/accept-as-note', acceptAsNoteHandler);
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
router.post('/projects', validateBody(CreateProjectBodySchema), createProjectHandler);
router.get('/projects', listProjectsHandler);
router.get('/projects/:id', getProjectHandler);
router.patch('/projects/:id', patchProjectHandler);
router.delete('/projects/:id', deleteProjectHandler);
router.post('/projects/:id/restore', restoreProjectHandler);
router.put('/projects/:id/sources', setProjectSourcesHandler);
router.post('/projects/:id/generate', generateManualHandler);
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
router.get('/projects/:id/coordination-report', getCoordinationReportHandler);
router.get('/projects/:id/open-comments', getProjectOpenCommentsHandler);
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
router.post('/revisions/:id/generate', generateRevisionHandler);
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
router.get('/conventions', listConventionsHandler);
router.get('/libraries', listLibrariesHandler);
router.post('/libraries/clients', createClientLibraryHandler);
// Literal `/libraries/import/jobs/:jobId` is 3 segments, so it never collides
// with the 2-segment `/libraries/:id/...` routes below (#135 / O-8).
router.get('/libraries/import/jobs/:jobId', importJobHandler);
router.post('/libraries/:id/import', parseRateLimit, upload.single('file'), importLibraryHandler);
router.get('/libraries/:id/specs', listLibrarySpecsHandler);
router.patch('/libraries/:id', renameLibraryHandler);
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
router.get('/projects/:id/required-sections', listBaselineRequiredSectionsHandler);
router.put(
  '/projects/:id/required-sections',
  validateBody(RequiredSectionsBodySchema),
  putBaselineRequiredSectionsHandler
);
router.get(
  '/projects/:id/packages/:packageId/required-sections',
  listPackageRequiredSectionsHandler
);
router.put(
  '/projects/:id/packages/:packageId/required-sections',
  validateBody(RequiredSectionsBodySchema),
  putPackageRequiredSectionsHandler
);
router.get('/specs/:id/paragraphs/:nodeId/associations', listAssociationsHandler);
router.post('/specs/:id/paragraphs/:nodeId/associations', createAssociationHandler);
router.delete(
  '/specs/:id/paragraphs/:nodeId/associations/:associationId',
  deleteAssociationHandler
);
