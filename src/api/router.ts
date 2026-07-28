import { type Router as RouterType, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../lib/env.js';
import { healthHandler } from './health.js';
import { searchHandler } from './search.js';
import {
  getSpecHandler,
  getSpecLineageHandler,
  getHierarchyReportHandler,
  updateSpecHandler,
  withdrawSpecHandler,
  restoreSpecHandler,
} from './specs.js';
import { setStyleSourceHandler, clearStyleSourceHandler } from './style-source.js';
import {
  updateParagraphHandler,
  removeParagraphHandler,
  insertParagraphHandler,
} from './paragraphs.js';
import { acquireLockHandler, releaseLockHandler, getLockHandler } from './locks.js';
import {
  createProjectHandler,
  listProjectsHandler,
  getProjectHandler,
  listProjectSpecsHandler,
  setProjectSourcesHandler,
  patchProjectHandler,
  deleteProjectHandler,
  restoreProjectHandler,
  addSectionToProjectHandler,
  removeSectionFromProjectHandler,
  getBrokenRefsHandler,
} from './projects.js';
import {
  listDisciplinesHandler,
  putLibraryDisciplinesHandler,
  clearLibraryDisciplinesHandler,
} from './disciplines.js';
import { getInboundReferencesHandler, getOutboundReferencesHandler } from './references.js';
import {
  getProjectReferenceGraphHandler,
  getLibraryReferenceGraphHandler,
} from './reference-graph.js';
import {
  getProjectStandardsHandler,
  getLibraryStandardsHandler,
  recordStandardVerificationHandler,
} from './standards.js';
import {
  createClientHandler,
  listClientsHandler,
  getClientHandler,
  updateClientHandler,
} from './clients.js';
import { resolveUserHandler, listUsersHandler, getUserHandler } from './users.js';
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
  createRevisionHandler,
  getRevisionHandler,
  listPackageRevisionsHandler,
} from './revisions.js';
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
  SubmittalRegisterBodySchema,
  SetSpecNumberingProfileBodySchema,
  HeaderFooterCompositionWriteSchema,
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
import { getProjectKeynotesHandler } from './keynotes.js';
import { getProjectRevitLinksHandler } from './revit-links.js';
import { compareReportHandler } from './reporting.js';
import { CompareRequestSchema } from '../reporting/index.js';
import { postSubmittalRegisterHandler } from './submittal-register.js';
import { getSpecOpenCommentsHandler, getProjectOpenCommentsHandler } from './open-comments.js';
import { getSpecReadinessHandler, getPackageReadinessHandler } from './readiness.js';
import { patchEditabilityHandler, reclassifyHandler, acceptAsNoteHandler } from './editability.js';
import {
  createAssociationHandler,
  listAssociationsHandler,
  deleteAssociationHandler,
} from './associations.js';
import {
  listProfilesHandler,
  createProfileHandler,
  getProfileHandler,
  patchProfileHandler,
  deleteProfileHandler,
  setSpecProfileHandler,
  clearSpecProfileHandler,
  snapshotHandler,
} from './numbering-profiles.js';
import {
  getLibraryHeaderFooterHandler,
  putLibraryHeaderFooterHandler,
  deleteLibraryHeaderFooterHandler,
  getProjectHeaderFooterHandler,
  putProjectHeaderFooterHandler,
  deleteProjectHeaderFooterHandler,
  getPackageHeaderFooterHandler,
  putPackageHeaderFooterHandler,
  deletePackageHeaderFooterHandler,
  getRevisionHeaderFooterHandler,
  putRevisionHeaderFooterHandler,
  deleteRevisionHeaderFooterHandler,
} from './header-footer.js';
import {
  resolveProjectHeaderFooterHandler,
  resolvePackageHeaderFooterHandler,
  resolveRevisionHeaderFooterHandler,
} from './header-footer-resolve.js';
import {
  getParagraphHistoryHandler,
  getSpecHistoryHandler,
  getHistoryDiffHandler,
} from './history.js';

const parseRateLimit = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  // Read live per request so a runtime change to config.RATE_LIMIT_UPLOAD_MAX takes effect
  // on the next request (see src/lib/env.ts). Limiting is skipped in tests and whenever it
  // is disabled via config (the web-UI demo sets DISABLE_RATE_LIMIT).
  limit: () => config.RATE_LIMIT_UPLOAD_MAX,
  skip: () => config.NODE_ENV === 'test' || config.DISABLE_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'too many requests — please wait before uploading again' },
});

export const router: RouterType = Router();

router.get('/health', healthHandler);
router.get('/search', searchHandler);
router.get('/specs/:id', getSpecHandler);
router.get('/specs/:id/open-comments', getSpecOpenCommentsHandler);
router.get('/specs/:id/readiness-report', getSpecReadinessHandler);
router.get('/specs/:id/lineage', getSpecLineageHandler);
router.get('/specs/:id/hierarchy-report', getHierarchyReportHandler);
router.get('/specs/:id/paragraphs/:nodeId/history', getParagraphHistoryHandler);
router.get('/specs/:id/history/diff', getHistoryDiffHandler);
router.get('/specs/:id/history', getSpecHistoryHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
router.delete('/specs/:id', withdrawSpecHandler);
router.post('/specs/:id/restore', restoreSpecHandler);
router.post('/specs/:id/paragraphs', insertParagraphHandler);
router.patch('/specs/:id/paragraphs/:nodeId', updateParagraphHandler);
router.patch('/specs/:id/paragraphs/:nodeId/removal', removeParagraphHandler);
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
router.post('/clients', createClientHandler);
router.get('/clients', listClientsHandler);
router.get('/clients/:id', getClientHandler);
router.patch('/clients/:id', updateClientHandler);
router.post('/users', resolveUserHandler);
router.get('/users', listUsersHandler);
router.get('/users/:id', getUserHandler);
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
router.get('/projects/:id/specs', listProjectSpecsHandler);
router.post(
  '/projects/:id/specs',
  validateBody(AddSectionToProjectBodySchema),
  addSectionToProjectHandler
);
router.delete('/projects/:id/specs/:specId', removeSectionFromProjectHandler);
router.get('/projects/:id/references/broken', getBrokenRefsHandler);
router.get('/projects/:id/coordination-report', getCoordinationReportHandler);
router.get('/projects/:id/keynotes', getProjectKeynotesHandler);
router.get('/projects/:id/revit-links', getProjectRevitLinksHandler);
router.post('/reports/compare', validateBody(CompareRequestSchema), compareReportHandler);
router.post(
  '/projects/:id/submittal-register',
  validateBody(SubmittalRegisterBodySchema),
  postSubmittalRegisterHandler
);
router.get('/projects/:id/open-comments', getProjectOpenCommentsHandler);
router.get('/projects/:id/references/inbound', getInboundReferencesHandler);
router.get('/projects/:id/reference-graph', getProjectReferenceGraphHandler);
router.get('/projects/:id/standards', getProjectStandardsHandler);
router.get('/projects/:id/specs/:specId/references', getOutboundReferencesHandler);
router.post('/projects/:id/packages', validateBody(CreatePackageBodySchema), createPackageHandler);
router.get('/projects/:id/packages', listPackagesHandler);
router.put('/packages/:id/specs', validateBody(SetPackageSpecsBodySchema), setPackageSpecsHandler);
router.delete('/packages/:id', deletePackageHandler);
router.get('/packages/:id/revisions', listPackageRevisionsHandler);
router.get('/packages/:id/readiness-report', getPackageReadinessHandler);
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
router.get('/disciplines', listDisciplinesHandler);
router.get('/libraries', listLibrariesHandler);
router.post('/libraries/clients', createClientLibraryHandler);
// Literal `/libraries/import/jobs/:jobId` is 3 segments, so it never collides
// with the 2-segment `/libraries/:id/...` routes below (#135 / O-8).
router.get('/libraries/import/jobs/:jobId', importJobHandler);
router.post('/libraries/:id/import', parseRateLimit, upload.single('file'), importLibraryHandler);
router.get('/libraries/:id/specs', listLibrarySpecsHandler);
router.get('/libraries/:id/reference-graph', getLibraryReferenceGraphHandler);
router.get('/libraries/:id/standards', getLibraryStandardsHandler);
// Standards registry verdict (#446, ADR-064). standardCode may contain reserved URL
// chars (e.g. a slash in A653/A653M) — clients percent-encode it in the path.
router.put('/standards/:orgCode/:standardCode', recordStandardVerificationHandler);
router.patch('/libraries/:id', renameLibraryHandler);
router.get('/libraries/:id/conventions', getLibraryConventionHandler);
router.put('/libraries/:id/conventions', putLibraryConventionHandler);
router.post('/libraries/:id/conventions/clone', cloneLibraryConventionHandler);
router.put('/libraries/:id/disciplines', putLibraryDisciplinesHandler);
router.delete('/libraries/:id/disciplines', clearLibraryDisciplinesHandler);
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
router.get('/libraries/:id/numbering-profiles', listProfilesHandler);
router.post('/libraries/:id/numbering-profiles', createProfileHandler);
// /numbering-profiles/snapshot MUST be registered before /numbering-profiles/:id
// so Express matches the literal path first (#299).
router.post('/numbering-profiles/snapshot', parseRateLimit, upload.single('file'), snapshotHandler);
router.get('/numbering-profiles/:id', getProfileHandler);
router.patch('/numbering-profiles/:id', patchProfileHandler);
router.delete('/numbering-profiles/:id', deleteProfileHandler);
router.put(
  '/specs/:id/numbering-profile',
  validateBody(SetSpecNumberingProfileBodySchema),
  setSpecProfileHandler
);
router.delete('/specs/:id/numbering-profile', clearSpecProfileHandler);
// Header/footer config (#476, ADR-040) — CRUD at 4 scopes plus a read-only
// effective-resolution view. `/header-footer/resolved` is a longer path than
// `/header-footer` so it never collides with the CRUD routes above it.
router.get('/libraries/:id/header-footer', getLibraryHeaderFooterHandler);
router.put(
  '/libraries/:id/header-footer',
  validateBody(HeaderFooterCompositionWriteSchema),
  putLibraryHeaderFooterHandler
);
router.delete('/libraries/:id/header-footer', deleteLibraryHeaderFooterHandler);
router.get('/projects/:id/header-footer', getProjectHeaderFooterHandler);
router.put(
  '/projects/:id/header-footer',
  validateBody(HeaderFooterCompositionWriteSchema),
  putProjectHeaderFooterHandler
);
router.delete('/projects/:id/header-footer', deleteProjectHeaderFooterHandler);
router.get('/packages/:id/header-footer', getPackageHeaderFooterHandler);
router.put(
  '/packages/:id/header-footer',
  validateBody(HeaderFooterCompositionWriteSchema),
  putPackageHeaderFooterHandler
);
router.delete('/packages/:id/header-footer', deletePackageHeaderFooterHandler);
router.get('/revisions/:id/header-footer', getRevisionHeaderFooterHandler);
router.put(
  '/revisions/:id/header-footer',
  validateBody(HeaderFooterCompositionWriteSchema),
  putRevisionHeaderFooterHandler
);
router.delete('/revisions/:id/header-footer', deleteRevisionHeaderFooterHandler);
router.get('/projects/:id/header-footer/resolved', resolveProjectHeaderFooterHandler);
router.get('/packages/:id/header-footer/resolved', resolvePackageHeaderFooterHandler);
router.get('/revisions/:id/header-footer/resolved', resolveRevisionHeaderFooterHandler);
