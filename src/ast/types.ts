import { z } from 'zod';
import {
  NodeTypeSchema,
  ArticleRoleSchema,
  SecRefSchema,
  StyleNodeTypeSchema,
  StylePropertiesSchema,
  SpecNodeEditabilitySchema,
} from './schemas.js';

export type NodeType = z.infer<typeof NodeTypeSchema>;

export type ArticleRole = z.infer<typeof ArticleRoleSchema>;

/**
 * A signal disagreement recorded by the 5-signal DOCX inference engine: a losing
 * signal that reported a different hierarchy level than the winning signal.
 * Mirrors parser/docx/types.ts SignalConflict — kept structurally identical;
 * the propagation site (inference.ts makeNode) is the single conversion point.
 */
export interface SignalConflict {
  readonly signal: 1 | 2 | 3 | 4 | 5;
  readonly reportedIlvl: number;
  readonly reportedNodeType: NodeType;
}

export interface SourceCommentFact {
  readonly author: string;
  readonly text: string;
  readonly anchor: readonly [number, number];
  /**
   * True when the comment is resolved per #256 C1 closure signals (#262): the
   * comment runs are struck through, OR the text ends in "Closed". The
   * open-comments report lists the comments where this is false.
   */
  readonly closed: boolean;
}

export interface SourceColorFact {
  readonly color: string;
  readonly coverage: number;
  readonly spans: readonly (readonly [number, number])[];
}

export interface SourceChoiceTokenFact {
  readonly kind: 'angle' | 'bracket';
  readonly options: readonly string[];
  readonly span: readonly [number, number];
}

export interface SourceFacts {
  readonly [key: string]: unknown;
  readonly comments?: readonly SourceCommentFact[];
  readonly colors?: readonly SourceColorFact[];
  readonly choiceTokens?: readonly SourceChoiceTokenFact[];
  readonly banner?: string;
  readonly vanish?: true;
}

/**
 * Effective editability surfaced on a classified paragraph (#134 / O-7). The
 * machine's `value`/`confidence`/`evidence` stay readable even when a human
 * `override` is present, so a UI can show what was overridden (O-15 badge).
 * Absent === the paragraph has not been classified.
 */
export type SpecNodeEditability = z.infer<typeof SpecNodeEditabilitySchema>;

// External content association surfaced on a paragraph (#109). Link + provenance
// only — never the licensed bytes (ADR-019). Keyed on the paragraph's w:sdt UUID.
export interface ParagraphAssociation {
  readonly id: string;
  readonly label: string;
  /** DMS connector identity (ADR-014 D5). Present together with externalId or absent. */
  readonly externalProvider?: string;
  readonly externalId?: string;
  /** Direct URL provenance for firms without a DMS connector. */
  readonly url?: string;
  /** sha256 hex of the referenced bytes, when known. */
  readonly contentHash?: string;
  readonly externalMetadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface SpecNodeMeta {
  readonly vanish?: boolean;
  readonly source?: 'ufgs' | 'arcat' | 'cpi' | 'unknown';
  readonly revitParam?: string;
  readonly baseVersion?: number;
  /** Inference signal disagreements. Absent === no conflicts (empty array never serialized). */
  readonly conflicts?: readonly SignalConflict[];
  readonly sourceFacts?: SourceFacts;
  /** Effective editability + machine why-chain. Absent === not yet classified. */
  readonly editability?: SpecNodeEditability;
  /** External content links (#109). Absent === none. */
  readonly associations?: readonly ParagraphAssociation[];
  /** Semantic CSI role of this article (ADR-033). Absent === unknown/non-article. */
  readonly articleRole?: ArticleRole;
}

export interface SpecNode {
  readonly id: string;
  readonly type: NodeType;
  readonly text: string;
  readonly children: readonly SpecNode[];
  readonly meta: SpecNodeMeta;
}

export type ParseWarningType =
  | 'root-continuation'
  | 'empty-part'
  | 'no-structure-found'
  | 'unusual-part-count'
  | 'pdf-needs-ocr'
  | 'pdf-degraded-extraction';

export interface ParseWarning {
  readonly type: ParseWarningType;
  readonly lineHint?: string;
  readonly suggestion?: string;
}

export interface SpecTree {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly parts: readonly SpecNode[];
  readonly warnings?: readonly ParseWarning[];
}

export type SecRef = z.infer<typeof SecRefSchema>;

// ── Style (ADR-021) ─────────────────────────────────────────────────────────
// StyleNodeType / STYLE_NODE_TYPES relocated here from db/queries/templates.ts:
// ast/ is the foundational layer (db/ depends on ast/, never the reverse).
export type StyleNodeType = z.infer<typeof StyleNodeTypeSchema>;
export const STYLE_NODE_TYPES = StyleNodeTypeSchema.options;

/**
 * OOXML-faithful per-NodeType visual style, stored as the `style_rules.properties`
 * JSONB payload. Typed keys are the ones we understand; the loose schema preserves
 * any other OOXML key a real document carries (the type carries an index signature).
 */
export type StyleProperties = z.infer<typeof StylePropertiesSchema>;

/**
 * Run (character) formatting properties extracted from a w:rPr element.
 * Derived from the rPr sub-shape of StylePropertiesSchema.
 */
export type RunProperties = NonNullable<StyleProperties['rPr']>;

/**
 * Paragraph formatting properties extracted from a w:pPr element.
 * Derived from the pPr sub-shape of StylePropertiesSchema.
 */
export type ParagraphProperties = NonNullable<StyleProperties['pPr']>;

/**
 * Numbering context (ilvl, numFmt, lvlText, start) resolved from a style's
 * effective numPr through numbering.xml. Derived from the numbering sub-shape
 * of StylePropertiesSchema.
 */
export type NumberingDef = NonNullable<StyleProperties['numbering']>;

/**
 * One per-NodeType style rule: the (nodeType, properties) pair stored in
 * style_rules. Lives in ast/ (foundational layer) so generator/ can accept
 * rules without importing db/ — mirrors the StyleNodeType relocation (#31).
 */
export interface StyleRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}

// ── Merge (ADR-005) ─────────────────────────────────────────────────────────
// ParagraphSnapshot is a pure data shape shared by db/ and merge/. It lives in
// ast/ (the foundational layer) so db/ never imports from merge/ — that would
// invert the module dependency graph. Mirrors the StyleNodeType relocation (#31).
export interface ParagraphSnapshot {
  readonly uuid: string;
  readonly text: string;
  readonly baseVersion: number;
}
