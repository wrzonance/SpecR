export type {
  NodeType,
  SignalConflict,
  SignalNumber,
  SignalProvenance,
  SpecNodeInference,
  SourceFacts,
  SourceColorFact,
  SourceChoiceTokenFact,
  SourceCommentFact,
  SpecNodeMeta,
  SpecNode,
  SpecTree,
  SecRef,
  ParagraphSnapshot,
  StyleRule,
  SpecNodeEditability,
  ArticleRole,
} from './types.js';
export {
  SignalNumberSchema,
  SignalProvenanceSchema,
  SpecNodeInferenceSchema,
} from './inference-schemas.js';
export {
  NodeTypeSchema,
  SignalConflictSchema,
  SourceFactsSchema,
  parseSourceFacts,
  SpecNodeMetaSchema,
  SpecNodeSchema,
  SpecTreeSchema,
  SecRefSchema,
  ParseWarningSchema,
  PatchSpecBodySchema,
  UpdateParagraphBodySchema,
  CreateProjectBodySchema,
  AddSectionToProjectBodySchema,
  SetProjectSourcesBodySchema,
  SetDivisionGeneralSpecBodySchema,
  CreatePackageBodySchema,
  SetPackageSpecsBodySchema,
  AcquireLockBodySchema,
  ReleaseLockBodySchema,
  ArticleRoleSchema,
} from './schemas.js';
export { deriveArticleRole, tagArticleRoles, ARTICLE_ROLE_RULES } from './article-role.js';
export { AstError } from './error.js';
export {
  NODE_TYPE_TO_NORMALIZED_ILVL,
  NODE_TYPES_BY_NORMALIZED_ILVL,
  nodeTypeToNormalizedIlvl,
} from './normalized-ilvl.js';
export { getLabel, consumesNumber } from './labels.js';
export type {
  UpdateParagraphBody,
  CreateProjectBody,
  AddSectionToProjectBody,
  SetProjectSourcesBody,
  SetDivisionGeneralSpecBody,
  CreatePackageBody,
  SetPackageSpecsBody,
  AcquireLockBody,
  ReleaseLockBody,
} from './schemas.js';
export {
  RevisionDateSchema,
  RevisionNomenclatureTypeSchema,
  RevisionNomenclatureTypesSchema,
  PutRevisionNomenclatureBodySchema,
  CloneRevisionNomenclatureBodySchema,
  RevisionAttributesSchema,
  CreateRevisionBodySchema,
  StructuredCreateRevisionBodySchema,
} from './revision-schemas.js';
export type {
  RevisionNomenclatureType,
  RevisionNomenclatureTypes,
  PutRevisionNomenclatureBody,
  CloneRevisionNomenclatureBody,
  RevisionAttributes,
  CreateRevisionBody,
  StructuredCreateRevisionBody,
} from './revision-schemas.js';
export type {
  StyleNodeType,
  StyleProperties,
  RunProperties,
  ParagraphProperties,
  NumberingDef,
} from './types.js';
export { STYLE_NODE_TYPES } from './types.js';
export { StyleNodeTypeSchema, StylePropertiesSchema } from './schemas.js';
export {
  EditabilitySchema,
  ConventionRulesSchema,
  ClassificationEvidenceSchema,
  SpecNodeEditabilitySchema,
} from './schemas.js';
export type { Editability, ConventionRules, ClassificationEvidence } from './schemas.js';
export { PutConventionBodySchema, CloneConventionBodySchema } from './schemas.js';
export type { PutConventionBody, CloneConventionBody } from './schemas.js';
export {
  PatchEditabilityBodySchema,
  PatchRemovalBodySchema,
  ReclassifyBodySchema,
} from './schemas.js';
export type { PatchEditabilityBody, PatchRemovalBody, ReclassifyBody } from './schemas.js';
export { InsertParagraphBodySchema, InsertableNodeTypeSchema } from './paragraph-schemas.js';
export type { InsertParagraphBody, InsertableNodeType } from './paragraph-schemas.js';
export {
  CreateTemplateBodySchema,
  PatchTemplateBodySchema,
  UpsertStyleRulesBodySchema,
  SetStyleSourceBodySchema,
} from './schemas.js';
export { GenerateBodySchema } from './generate-schemas.js';
export type {
  CreateTemplateBody,
  PatchTemplateBody,
  UpsertStyleRulesBody,
  SetStyleSourceBody,
} from './schemas.js';
export type { GenerateBody } from './generate-schemas.js';
export {
  HeaderFooterCompositionSchema,
  HeaderFooterFieldKindSchema,
  HeaderFooterVariantSchema,
  PageNumberingModeSchema,
  defaultVariant,
} from './header-footer-schemas.js';
export type {
  HeaderFooterComposition,
  HeaderFooterFieldKind,
  HeaderFooterVariant,
  PageNumberingMode,
} from './header-footer-schemas.js';
export { RequiredSectionsBodySchema } from './required-sections-schemas.js';
export type { RequiredSectionsBody } from './required-sections-schemas.js';
export { CreateAssociationBodySchema } from './association-schemas.js';
export type { CreateAssociationBody } from './association-schemas.js';
export { DiffResultSchema, MergeFieldsShape, MergeBodySchema } from './merge-schemas.js';
export type { MergeBody } from './merge-schemas.js';
export { SubmittalRegisterBodySchema } from './submittal-register-schemas.js';
export type { SubmittalRegisterBody } from './submittal-register-schemas.js';
export type { ParagraphAssociation } from './types.js';
export type { ParseWarning, ParseWarningType } from './types.js';
export { textEndsWithClosed } from './comment-closure.js';
export {
  NumberingProfileSchema,
  NumberingProfileReadSchema,
  TierNameSchema,
} from './numbering-profile-schema.js';
export type { NumberingProfile, TierName } from './numbering-profile-schema.js';
export {
  CreateNumberingProfileBodySchema,
  PatchNumberingProfileBodySchema,
  SetSpecNumberingProfileBodySchema,
} from './schemas.js';
export type {
  CreateNumberingProfileBody,
  PatchNumberingProfileBody,
  SetSpecNumberingProfileBody,
} from './schemas.js';
