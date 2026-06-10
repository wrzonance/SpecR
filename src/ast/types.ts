import { z } from 'zod';
import {
  NodeTypeSchema,
  SecRefSchema,
  StyleNodeTypeSchema,
  StylePropertiesSchema,
} from './schemas.js';

export type NodeType = z.infer<typeof NodeTypeSchema>;

export interface SpecNodeMeta {
  readonly vanish?: boolean;
  readonly source?: 'ufgs' | 'arcat' | 'cpi' | 'unknown';
  readonly revitParam?: string;
  readonly baseVersion?: number;
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
  | 'unusual-part-count';

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
