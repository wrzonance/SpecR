import { Pool } from 'pg';
import { config } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { DatabaseError } from './errors.js';

export { DatabaseError } from './errors.js';
export { bumpSpecContentVersion } from './queries/content-version.js';

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
  getSpecSource,
  persistParsedSpec,
  withdrawSpec,
  restoreSpec,
  getSpecWithdrawnAt,
} from './queries/specs.js';
export type {
  SpecSummary,
  UpdateSpecInput,
  CreateSpecInput,
  SpecTreeResult,
  SpecReference,
  OriginMeta,
  WithdrawSpecOutcome,
  RestoreSpecOutcome,
} from './queries/specs.js';
export { getOnboardingStatus, finalizeOnboarding, reopenOnboarding } from './queries/onboarding.js';
export type { OnboardingStatus, FinalizeOutcome, ReopenOutcome } from './queries/onboarding.js';
export {
  insertTree,
  getParagraphWithAncestors,
  getParagraphSpecId,
  updateParagraphText,
} from './queries/paragraphs.js';
export type {
  ParagraphRow,
  ParagraphWithAncestors,
  UpdateParagraphResult,
} from './queries/paragraphs.js';
// insertSiblingRow / setVanishRow are the gate-free DB cores behind
// insertParagraphAfter / setParagraphVanish AND the merge engine's added/deleted-op
// apply (src/merge/conflict.ts, #374) — its first cross-module consumer.
export { insertParagraphAfter, insertSiblingRow } from './queries/paragraph-insert.js';
export type { InsertParagraphResult, InsertParagraphInput } from './queries/paragraph-insert.js';
export { setParagraphVanish, setVanishRow } from './queries/paragraph-vanish.js';
export type { SetVanishResult, SetVanishRowResult } from './queries/paragraph-vanish.js';
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
  findSoleProjectSectionNumberFormat,
  listProjects,
  setProjectSources,
  updateProject,
  softDeleteProject,
  restoreProject,
  InvalidSourceLibraryError,
} from './queries/projects.js';
export type {
  ProjectSummary,
  ProjectListItem,
  ProjectWithToc,
  ProjectTocEntry,
  ProjectSource,
  ProjectTombstone,
  CreateProjectInput,
  UpdateProjectInput,
  UpdateProjectResult,
} from './queries/projects.js';
export { listProjectSpecs } from './queries/project-specs.js';
export type { ProjectSpec, ProjectSpecListOptions } from './queries/project-specs.js';
export { getBrokenRefs } from './queries/project-refs.js';
export type { BrokenRef } from './queries/project-refs.js';
export {
  createClient,
  listClients,
  getClient,
  assertClientExists,
  ClientNotFoundError,
  ClientLibraryNotFoundError,
} from './queries/clients.js';
export type { ClientSummary, ClientDetail, CreateClientInput } from './queries/clients.js';
export {
  searchParagraphs,
  toSearchOptions,
  listSpecSections,
  lookupSpecSectionTitle,
} from './queries/search.js';
export { getParagraphSnapshots, getCurrentParagraphSnapshots } from './queries/versions.js';
export type {
  ParagraphSearchResult,
  ParagraphSearchOptions,
  SpecSectionResult,
} from './queries/search.js';
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
export { getProjectRevitLinks } from './queries/revit-links.js';
export type {
  RevitLinkInventory,
  RevitElementLinks,
  RevitSpecLinks,
  RevitLinkedSpec,
  RevitLinkSummary,
  RevitLinkFilter,
} from './queries/revit-links.js';
export {
  createLibrary,
  createClientLibrary,
  findLibraryById,
  findLibraryByName,
  listLibraries,
  listLibrarySpecs,
  updateLibraryName,
  resolveDefaultLibraryId,
  ParentLibraryNotFoundError,
  ParentLibraryNotCompanyError,
  DefaultCompanyLibraryError,
  UFGS_REFERENCE_LIBRARY,
  DEFAULT_COMPANY_LIBRARY,
} from './queries/libraries.js';
export { LibraryNotFoundError } from './queries/libraries.js';
export type {
  Library,
  LibraryTier,
  CreateLibraryInput,
  CreateClientLibraryInput,
  LibrarySpec,
  LibrarySpecListOptions,
} from './queries/libraries.js';
export { getReferenceGraph } from './queries/reference-graph-read.js';
export type { GraphScope } from './queries/reference-graph-read.js';
export type {
  ReferenceGraph,
  GraphNode,
  GraphEdge,
  UmbrellaDivision,
  GraphScopeRef,
} from './queries/reference-graph.js';
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
export { listPackageRevisions } from './queries/revision-list.js';
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
  seedLibraryConventionIfAbsent,
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
export {
  setSpecEditabilityOverride,
  clearSpecEditabilityOverride,
  reclassifySpec,
  acceptCommentAsNote,
} from './queries/reclassify.js';
export type {
  OwnershipResult,
  EditabilityDiffEntry,
  ReclassifyReport,
  ReclassifyOutcome,
  AcceptNoteOutcome,
} from './queries/reclassify.js';
export { getSpecLineage } from './queries/lineage.js';
export type { SpecLineage, LineageHop, LineageScope } from './queries/lineage.js';
export {
  getSpecStyleSource,
  setSpecStyleSource,
  clearSpecStyleSource,
  countSpecsUsingTemplate,
} from './queries/style-source.js';
export type { SpecStyleSource, SetSpecStyleResult } from './queries/style-source.js';
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
export {
  listNumberingProfiles,
  getNumberingProfile,
  createNumberingProfile,
  updateNumberingProfile,
  deleteNumberingProfile,
  setSpecNumberingProfile,
  clearSpecNumberingProfile,
  getEffectiveNumberingProfile,
  NumberingProfileInUseError,
} from './queries/numbering-profiles.js';
export type { NumberingProfileRow } from './queries/numbering-profiles.js';
export { getCoordinationReport } from './queries/coordination.js';
export type { Finding, CoordinationSummary, CoordinationReport } from './queries/coordination.js';
export {
  getSubmittalRegister,
  SubmittalRegisterProjectNotFoundError,
  SubmittalRegisterSpecNotInProjectError,
} from './queries/submittal-register.js';
export type { ProjectSubmittalRegister } from './queries/submittal-register.js';
export { getOpenCommentsReport } from './queries/open-comments.js';
export type {
  OpenComment,
  OpenCommentsScope,
  OpenCommentsSummary,
  OpenCommentsReport,
} from './queries/open-comments.js';
export {
  createAssociation,
  listAssociationsForParagraph,
  listAssociationsForSpec,
  deleteAssociation,
  AssociationParagraphNotFoundError,
} from './queries/associations.js';
export type { CreateAssociationInput } from './queries/associations.js';
export { getProjectKeynotes } from './queries/keynotes.js';
export type { ProjectKeynote } from './queries/keynotes.js';
export { getComparisonColumns, getComparisonParagraphs } from './queries/reporting.js';
export type { ComparisonColumnMeta, ComparisonParagraphRow } from './queries/reporting.js';
// ADR-065 — discipline mapping (scoped-profile: built-in default + per-library override).
// resolveEffectiveRules/disciplineForSection and the resolved-view types stay internal to the
// db module (used by the listing queries via relative import), so only the externally-consumed
// symbols are surfaced here.
export {
  listDisciplines,
  replaceLibraryDisciplineRules,
  clearLibraryDisciplineRules,
  DisciplineNotFoundError,
} from './queries/disciplines.js';
// Standards registry (#446, ADR-064)
export { getStandardsRollup, recordStandardVerification } from './queries/standards-read.js';
export type {
  StandardsScope,
  StandardRecord,
  RecordVerificationInput,
} from './queries/standards-read.js';
export {
  buildStandardsRollup,
  parseStandardCitation,
  STANDARD_ANCHOR_CAP,
} from './queries/standards.js';
export type {
  StandardsRollup,
  StandardRollupRow,
  StandardFinding,
  StandardsSummary,
  StandardStatus,
  CitingSpec,
} from './queries/standards.js';
