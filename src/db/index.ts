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
export { insertTree, getParagraphWithAncestors } from './queries/paragraphs.js';
export type { ParagraphRow, ParagraphWithAncestors } from './queries/paragraphs.js';
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
  resolveDefaultLibraryId,
  UFGS_REFERENCE_LIBRARY,
  DEFAULT_COMPANY_LIBRARY,
} from './queries/libraries.js';
export type { Library, LibraryTier, CreateLibraryInput } from './queries/libraries.js';
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
  SnapshotValidationError,
} from './queries/revisions.js';
export type { RevisionSummary, RevisionSpecEntry, RevisionWithTrees } from './queries/revisions.js';
export {
  insertConvention,
  updateConventionRules,
  findConventionById,
  getBuiltInConvention,
  getConventionForLibrary,
  BUILT_IN_CONVENTION_NAME,
  ConventionValidationError,
  ConventionNotFoundError,
} from './queries/conventions.js';
export type { EditingConvention, CreateConventionInput } from './queries/conventions.js';
export { getSpecLineage } from './queries/lineage.js';
export type { SpecLineage, LineageHop, LineageScope } from './queries/lineage.js';
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
