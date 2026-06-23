import { Pool } from 'pg';
import { config } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { DatabaseError } from './errors.js';

export { DatabaseError } from './errors.js';

export function createPool(): Pool {
  return new Pool({ connectionString: config.DATABASE_URL });
}

export async function pingDatabase(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new DatabaseError('database ping failed', { cause: err });
  }
}

export const pool = createPool();

pool.on('error', (err: Error) => {
  logger.error({ err }, 'pg pool error');
});

export {
  findSpecById,
  updateSpec,
  createSpec,
  getSpecTree,
  persistParsedSpec,
} from './queries/specs.js';
export type {
  SpecSummary,
  UpdateSpecInput,
  CreateSpecInput,
  SpecTreeResult,
  SpecReference,
  OriginMeta,
} from './queries/specs.js';
export {
  insertTree,
  getParagraphWithAncestors,
  updateParagraphText,
} from './queries/paragraphs.js';
export type {
  ParagraphRow,
  ParagraphWithAncestors,
  UpdateParagraphResult,
} from './queries/paragraphs.js';
export {
  insertRefs,
  getInboundReferences,
  getOutboundReferences,
  findProjectSpecIdsBySection,
  isSpecInProject,
} from './queries/refs.js';
export type { InboundReference, OutboundReference } from './queries/refs.js';
export {
  createProject,
  findProjectById,
  listProjects,
  setProjectSources,
  getBrokenRefs,
  InvalidSourceLibraryError,
} from './queries/projects.js';
export type {
  ProjectSummary,
  ProjectListItem,
  ProjectWithToc,
  ProjectTocEntry,
  ProjectSource,
  BrokenRef,
  CreateProjectInput,
} from './queries/projects.js';
export { searchParagraphs, listSpecSections, lookupSpecSectionTitle } from './queries/search.js';
export { getParagraphSnapshots, getCurrentParagraphSnapshots } from './queries/versions.js';
export type { ParagraphSearchResult, SpecSectionResult } from './queries/search.js';
export {
  getTemplate,
  getTemplateByName,
  listTemplates,
  createTemplate,
  createTemplateWithRules,
  upsertStyleRule,
  updateTemplateMeta,
  deleteTemplate,
  bulkUpsertTemplateRules,
} from './queries/templates.js';
export { STYLE_NODE_TYPES } from './queries/templates.js';
export type {
  StyleNodeType,
  StyleRule,
  Template,
  TemplateMeta,
  StyleProperties,
  DeleteTemplateResult,
} from './queries/templates.js';
export {
  upsertMapping,
  deleteMapping,
  getMappingsBySpec,
  getMappingsByInstance,
  getMappingsByParagraph,
} from './queries/revit.js';
export type {
  RevitMapping,
  RevitMappingInput,
  RevitDirection,
  RevitTransformType,
} from './queries/revit.js';
export {
  createLibrary,
  findLibraryById,
  findLibraryByName,
  listLibraries,
  listLibrarySpecs,
  updateLibraryName,
  resolveDefaultLibraryId,
  UFGS_REFERENCE_LIBRARY,
  DEFAULT_COMPANY_LIBRARY,
} from './queries/libraries.js';
export type { Library, LibraryTier, CreateLibraryInput, LibrarySpec } from './queries/libraries.js';
export {
  addSectionToProject,
  removeSectionFromProject,
  ProjectNotFoundError,
  SectionUnresolvedError,
} from './queries/derive.js';
export type { AddSectionResult, SourceLibraryRef, RemoveSectionOutcome } from './queries/derive.js';
export {
  createPackage,
  listPackages,
  setPackageSpecs,
  deletePackage,
  PackageNotFoundError,
  SpecNotInProjectError,
} from './queries/packages.js';
export type { PackageSummary, PackageWithSpecs, PackageSpecEntry } from './queries/packages.js';
export {
  createPackageRevision,
  getPackageRevision,
  getPackageRevisionManualData,
  getPackageRevisionAddendumManualData,
  SnapshotValidationError,
  RevisionNomenclatureValidationError,
  RevisionComparisonError,
} from './queries/revisions.js';
export type {
  RevisionSummary,
  RevisionSpecEntry,
  RevisionWithTrees,
  RevisionManualData,
  RevisionAddendumManualData,
} from './queries/revisions.js';
export {
  insertConvention,
  updateConventionRules,
  findConventionById,
  getBuiltInConvention,
  listBuiltInConventions,
  getConventionForLibrary,
  upsertLibraryConvention,
  BUILT_IN_CONVENTION_NAME,
  ConventionValidationError,
  ConventionNotFoundError,
} from './queries/conventions.js';
export type { EditingConvention, CreateConventionInput } from './queries/conventions.js';
export {
  listRevisionNomenclatureProfiles,
  findRevisionNomenclatureProfileById,
  getBuiltInRevisionNomenclature,
  getRevisionNomenclatureForProject,
  upsertProjectRevisionNomenclature,
  deleteProjectRevisionNomenclature,
  BUILT_IN_REVISION_NOMENCLATURE_NAME,
} from './queries/revision-nomenclature.js';
export type { RevisionNomenclatureProfile } from './queries/revision-nomenclature.js';
export {
  storeClassifications,
  setEditabilityOverride,
  clearEditabilityOverride,
} from './queries/editability.js';
export { getSpecLineage } from './queries/lineage.js';
export type { SpecLineage, LineageHop, LineageScope } from './queries/lineage.js';
export {
  getSpecStyleSource,
  setSpecStyleSource,
  clearSpecStyleSource,
  countSpecsUsingTemplate,
} from './queries/style-source.js';
export type { SpecStyleSource } from './queries/style-source.js';
export { acquireLock, releaseLock, getLock, DEFAULT_LOCK_TTL_SECONDS } from './queries/locks.js';
export type { LockState, AcquireLockResult } from './queries/locks.js';
export {
  assertSpecWritable,
  SpecNotFoundError,
  SpecWriteForbiddenError,
  StaleVersionError,
} from './queries/edit-gate.js';
export {
  getLibraryDivisionGeneralSpec,
  getProjectDivisionGeneralSpec,
  setLibraryDivisionGeneralSpec,
  setProjectDivisionGeneralSpec,
  reconcileLibraryDivisionGeneralSpec,
  reconcileProjectDivisionGeneralSpec,
  DivisionGeneralOwnerNotFoundError,
  DivisionGeneralSpecNotInScopeError,
} from './queries/division-general.js';
export type {
  DivisionGeneralSpecResult,
  DivisionGeneralSpecRef,
  DivisionGeneralCandidate,
  DivisionGeneralScope,
  DivisionGeneralStatus,
  DivisionGeneralMethod,
  DivisionGeneralCandidateReason,
  DivisionGeneralConfidence,
  SetDivisionGeneralSpecInput,
} from './queries/division-general.js';
export {
  upsertHeaderFooterConfig,
  findHeaderFooterConfig,
  deleteHeaderFooterConfig,
  resolveHeaderFooterConfig,
  HeaderFooterValidationError,
  HeaderFooterScopeError,
} from './queries/header-footer.js';
export type {
  HeaderFooterScopeInput,
  HeaderFooterScope,
  HeaderFooterConfig,
  ResolveHeaderFooterConfigInput,
  HeaderFooterResolutionContext,
  ResolvedHeaderFooterConfig,
} from './queries/header-footer.js';
export {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsProjectNotFoundError,
  RequiredSectionsPackageNotFoundError,
  RequiredSectionsSeedConflictError,
  RequiredSectionsInvalidSeedError,
} from './queries/required-sections.js';
export type {
  RequiredSection,
  RequiredSectionInput,
  RequiredScope,
  SeedSource,
} from './queries/required-sections.js';
export { getCoordinationReport } from './queries/coordination.js';
export type { Finding, CoordinationSummary, CoordinationReport } from './queries/coordination.js';
