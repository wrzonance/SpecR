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
  type SpecSummary,
  type UpdateSpecInput,
  type CreateSpecInput,
  type SpecTreeResult,
  type SpecReference,
  type OriginMeta,
  type WithdrawSpecOutcome,
  type RestoreSpecOutcome,
} from './queries/specs.js';
export { getOnboardingStatus, finalizeOnboarding, reopenOnboarding } from './queries/onboarding.js';
export type { OnboardingStatus, FinalizeOutcome, ReopenOutcome } from './queries/onboarding.js';
export {
  insertTree,
  getParagraphWithAncestors,
  getParagraphSpecId,
  updateParagraphText,
  lockedObjectMessage,
  type ParagraphRow,
  type ParagraphWithAncestors,
  type UpdateParagraphResult,
} from './queries/paragraphs.js';
// insertSiblingRow / setVanishRow are the gate-free DB cores behind
// insertParagraphAfter / setParagraphVanish AND the merge engine's added/deleted-op
// apply (src/merge/conflict.ts, #374) — its first cross-module consumer.
export { insertParagraphAfter, insertSiblingRow } from './queries/paragraph-insert.js';
export type { InsertParagraphResult, InsertParagraphInput } from './queries/paragraph-insert.js';
export { setParagraphVanish, setVanishRow } from './queries/paragraph-vanish.js';
export type { SetVanishResult, SetVanishRowResult } from './queries/paragraph-vanish.js';
// #545, ADR-079 follow-on — the acknowledgement toggle (clears
// specifier_note_present / body_object_present) and the comment-closure
// toggle (clears open_comment), mirroring setParagraphVanish's gate-free/
// gated core split exactly.
export {
  setParagraphAcknowledged,
  setAcknowledgedRow,
} from './queries/paragraph-acknowledgement.js';
export type {
  SetAcknowledgedResult,
  SetAcknowledgedRowResult,
} from './queries/paragraph-acknowledgement.js';
export {
  setParagraphCommentClosed,
  setCommentClosedRow,
} from './queries/paragraph-comment-closure.js';
export type {
  SetCommentClosedResult,
  SetCommentClosedRowResult,
} from './queries/paragraph-comment-closure.js';
// ADR-052 D3/D4/D9 (#380) — checkpoints, coalesced paragraph-history sessions,
// per-paragraph reject (a restore-to-version write through updateParagraphText
// above), and pending-change summaries all barrel through checkpoint-index.ts
// (mirrors history-index.ts's history.js + history-diff.js pattern) — one
// export line standing in for what would otherwise be four separate
// multi-symbol blocks.
export * from './queries/checkpoint-index.js';
// rewriteObjectTextBlob is the DB core behind rewriting an objectText child's
// text into its parent object row's captured blob (#519) — paragraphs.ts's
// own write path (applyParagraphUpdate) already calls it internally; the
// merge engine's accept path (src/merge/conflict.ts, #520) is its second
// cross-module consumer.
export { rewriteObjectTextBlob } from './queries/object-text-edit.js';
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
  softDeleteProject,
  restoreProject,
  InvalidSourceLibraryError,
  type ProjectSummary,
  type ProjectListItem,
  type ProjectWithToc,
  type ProjectTocEntry,
  type ProjectSource,
  type ProjectTombstone,
  type CreateProjectInput,
} from './queries/projects.js';
export { updateProject } from './queries/project-update.js';
export type { UpdateProjectInput, UpdateProjectResult } from './queries/project-update.js';
export { listProjectSpecs } from './queries/project-specs.js';
export type { ProjectSpec, ProjectSpecListOptions } from './queries/project-specs.js';
export { getBrokenRefs, type BrokenRef } from './queries/project-refs.js';
export {
  createClient,
  listClients,
  getClient,
  updateClient,
  assertClientExists,
  ClientNotFoundError,
  ClientLibraryNotFoundError,
} from './queries/clients.js';
export type { ClientSummary, ClientDetail } from './queries/clients.js';
export type { CreateClientInput, UpdateClientInput } from './queries/clients.js';
export {
  searchParagraphs,
  toSearchOptions,
  listSpecSections,
  lookupSpecSectionTitle,
  type ParagraphSearchResult,
  type ParagraphSearchOptions,
  type SpecSectionResult,
} from './queries/search.js';
export { getParagraphSnapshots, getCurrentParagraphSnapshots } from './queries/versions.js';
export * from './queries/history-index.js';
export { getObjectStructuralSnapshots } from './queries/object-structure.js';
export type { ObjectStructuralSnapshot } from './queries/object-structure.js';
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
  STYLE_NODE_TYPES,
  type StyleNodeType,
  type StyleRule,
  type Template,
  type TemplateMeta,
  type StyleProperties,
  type DeleteTemplateResult,
} from './queries/templates.js';
export {
  upsertMapping,
  deleteMapping,
  getMappingsBySpec,
  getMappingsByInstance,
  getMappingsByParagraph,
  type RevitMapping,
  type RevitMappingInput,
  type RevitDirection,
  type RevitTransformType,
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
// Flattened to `export *` (#380 task 7 groundwork) — this block previously
// named all 19 of libraries.ts's exports individually; verified identical to
// a full `export *` (every symbol libraries.ts exports was already listed),
// freeing 21 lines so the rejectParagraphToCheckpoint export above fits under
// the enforced max-lines: 400 (see ADR-052's D3 amendment note on this file's
// line budget).
export * from './queries/libraries.js';
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
  RevisionParentValidationError,
  type RevisionSummary,
  type RevisionSpecEntry,
  type RevisionWithTrees,
  type RevisionManualData,
  type RevisionAddendumManualData,
} from './queries/revisions.js';
export { isUnprocessableRevisionInputError } from './queries/revision-input-errors.js';
export { listPackageRevisions } from './queries/revision-list.js';
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
  type OwnershipResult,
  type SetOverrideOutcome,
  type EditabilityDiffEntry,
  type ReclassifyReport,
  type ReclassifyOutcome,
  type AcceptNoteOutcome,
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
// division-general.js's named list above was a complete 1:1 re-export of its
// public surface (verified against the module source) — collapsed to `export
// *` to free budget in the barrel's enforced 400-code-line ceiling (see
// 318e8c2's history-index.ts precedent) for the new language-rule-profiles
// export just below.
export * from './queries/division-general.js';
export {
  upsertHeaderFooterConfig,
  findHeaderFooterConfig,
  deleteHeaderFooterConfig,
  resolveHeaderFooterConfig,
  HeaderFooterValidationError,
  HeaderFooterScopeError,
  type HeaderFooterScopeInput,
  type HeaderFooterScope,
  type HeaderFooterConfig,
  type ResolveHeaderFooterConfigInput,
  type HeaderFooterResolutionContext,
  type ResolvedHeaderFooterConfig,
} from './queries/header-footer.js';
// Single-spec generation-context resolution (#267/#304) — scopes a spec to its
// sole owning project once, yielding both the section-number-format fallback
// and the effective header/footer config from ONE ownership snapshot (or null
// fields when orphaned/ambiguous/unconfigured).
// `resolveProjectManualHeaderFooterContext`/`resolveRevisionHeaderFooterContext`
// (#481) are the whole-manual counterparts: project- and revision-scoped
// header/footer resolution for the /projects/{id}/generate and
// /revisions/{id}/generate DOCX builds.
export {
  resolveSpecGenerationContext,
  resolveProjectManualHeaderFooterContext,
  resolveRevisionHeaderFooterContext,
} from './queries/header-footer-context.js';
export type {
  ProjectIdentity,
  HeaderFooterFieldSource,
  HeaderFooterGenerationContext,
  SpecGenerationContext,
  RevisionHeaderFooterFieldSource,
} from './queries/header-footer-context.js';
export {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsProjectNotFoundError,
  RequiredSectionsPackageNotFoundError,
  RequiredSectionsSeedConflictError,
  RequiredSectionsInvalidSeedError,
  type RequiredSection,
  type RequiredSectionInput,
  type RequiredScope,
  type SeedSource,
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
// Open-comments report + all issuance-readiness (ADR-079, #406) exports live
// in this sub-barrel — see index-readiness.ts for why.
export * from './index-readiness.js';
export {
  createAssociation,
  listAssociationsForParagraph,
  listAssociationsForSpec,
  deleteAssociation,
  AssociationParagraphNotFoundError,
} from './queries/associations.js';
export type { CreateAssociationInput } from './queries/associations.js';
export { getProjectKeynotes, type ProjectKeynote } from './queries/keynotes.js';
export { getComparisonColumns, getComparisonParagraphs } from './queries/reporting.js';
export type { ComparisonColumnMeta, ComparisonParagraphRow } from './queries/reporting.js';
export { getFrozenComparisonSource } from './queries/reporting.js';
export type { FrozenComparisonSource } from './queries/reporting.js';
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
  type StandardsRollup,
  type StandardRollupRow,
  type StandardFinding,
  type StandardsSummary,
  type StandardStatus,
  type CitingSpec,
} from './queries/standards.js';
// Actor identity substrate (#381, ADR-052 D6). role_assignments (migration 045) ships
// schema-only — its query/REST/MCP layer is a deferred follow-up, not exported here.
export { resolveOrCreateUserByLabel, listUsers, getUser } from './queries/users.js';
export type { UserSummary } from './queries/users.js';
// Write-history capture core (#377, ADR-052 D1) — the merge engine's applyAccepted/
// applyMerge (src/merge/) is the first cross-module consumer that threads a resolved
// ParagraphHistoryContext through its own call graph rather than resolving it itself.
export {
  recordParagraphHistory,
  resolveHistoryContext,
  lazyHistoryContext,
  SYSTEM_ACTOR_LABEL,
} from './queries/paragraph-history.js';
// Language-rule profiles (#411, ADR-080) — routed via `export *` (not a named
// list) to stay within the barrel's enforced 400-code-line ceiling; see
// 318e8c2's history-index.ts precedent for the same constraint.
export * from './queries/language-rule-profiles.js';
// Language-rule findings scan engine (#411, ADR-080) — same `export *`
// rationale as language-rule-profiles.js just above.
export * from './queries/language-rule-findings.js';
export type { ParagraphHistoryContext } from './queries/paragraph-history.js';
