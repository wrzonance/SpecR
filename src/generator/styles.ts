import { AlignmentType, LineRuleType } from 'docx';
import type {
  NodeType,
  ParagraphProperties,
  RunProperties,
  StyleProperties,
  StyleRule,
} from '../ast/index.js';

/** Keyed by NodeType (superset of StyleNodeType) so callers can look up any node. */
export type StyleRuleMap = ReadonlyMap<NodeType, StyleProperties>;

export function buildRuleMap(rules: readonly StyleRule[]): StyleRuleMap {
  return new Map(rules.map((r) => [r.nodeType, r.properties]));
}

type DocxAlignment = (typeof AlignmentType)[keyof typeof AlignmentType];
type DocxLineRule = (typeof LineRuleType)[keyof typeof LineRuleType];

const ALIGNMENT: Record<
  'left' | 'center' | 'right' | 'both' | 'distribute' | 'start' | 'end',
  DocxAlignment
> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  both: AlignmentType.BOTH,
  distribute: AlignmentType.DISTRIBUTE,
  start: AlignmentType.START,
  end: AlignmentType.END,
};

const LINE_RULE: Record<'auto' | 'exact' | 'atLeast', DocxLineRule> = {
  auto: LineRuleType.AUTO,
  exact: LineRuleType.EXACT,
  atLeast: LineRuleType.AT_LEAST,
};

export interface RunStyleOptions {
  readonly font?: string;
  /** Half-points — same unit as OOXML w:sz; docx TextRun size is also half-points. */
  readonly size?: number;
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly allCaps?: boolean;
  readonly smallCaps?: boolean;
}

export function runStyleOptions(rPr: RunProperties | undefined): RunStyleOptions {
  if (!rPr) return {};
  const out: { -readonly [K in keyof RunStyleOptions]: RunStyleOptions[K] } = {};
  if (rPr.rFonts?.ascii !== undefined) out.font = rPr.rFonts.ascii;
  if (rPr.sz !== undefined) out.size = rPr.sz;
  if (rPr.b !== undefined) out.bold = rPr.b;
  if (rPr.i !== undefined) out.italics = rPr.i;
  if (rPr.caps !== undefined) out.allCaps = rPr.caps;
  if (rPr.smallCaps !== undefined) out.smallCaps = rPr.smallCaps;
  return out;
}

interface SpacingOptions {
  readonly before?: number;
  readonly after?: number;
  readonly line?: number;
  readonly lineRule?: DocxLineRule;
}

interface IndentOptions {
  readonly left?: number;
  readonly right?: number;
  readonly firstLine?: number;
  readonly hanging?: number;
}

export interface ParagraphStyleOptions {
  readonly spacing?: SpacingOptions;
  readonly indent?: IndentOptions;
  readonly alignment?: DocxAlignment;
  readonly contextualSpacing?: boolean;
}

function spacingOptions(spacing: NonNullable<ParagraphProperties['spacing']>): SpacingOptions {
  const out: { -readonly [K in keyof SpacingOptions]: SpacingOptions[K] } = {};
  if (spacing.before !== undefined) out.before = spacing.before;
  if (spacing.after !== undefined) out.after = spacing.after;
  if (spacing.line !== undefined) out.line = spacing.line;
  if (spacing.lineRule !== undefined) out.lineRule = LINE_RULE[spacing.lineRule];
  return out;
}

function indentOptions(ind: NonNullable<ParagraphProperties['ind']>): IndentOptions {
  const out: { -readonly [K in keyof IndentOptions]: IndentOptions[K] } = {};
  if (ind.left !== undefined) out.left = ind.left;
  if (ind.right !== undefined) out.right = ind.right;
  if (ind.firstLine !== undefined) out.firstLine = ind.firstLine;
  if (ind.hanging !== undefined) out.hanging = ind.hanging;
  return out;
}

export function paragraphStyleOptions(pPr: ParagraphProperties | undefined): ParagraphStyleOptions {
  if (!pPr) return {};
  const out: { -readonly [K in keyof ParagraphStyleOptions]: ParagraphStyleOptions[K] } = {};
  if (pPr.spacing !== undefined) {
    out.spacing = spacingOptions(pPr.spacing);
    if (pPr.spacing.contextualSpacing !== undefined) {
      out.contextualSpacing = pPr.spacing.contextualSpacing;
    }
  }
  if (pPr.ind !== undefined) out.indent = indentOptions(pPr.ind);
  if (pPr.jc !== undefined) {
    out.alignment = ALIGNMENT[pPr.jc];
  }
  return out;
}
