// OOXML intermediate types — normalized shapes used across the DOCX parser pipeline.

import type { NodeType, SourceFacts } from '../../ast/types.js';

// ─── numbering.xml ────────────────────────────────────────────────────────────

export interface AbstractNumLevel {
  readonly ilvl: number;
  readonly numFmt: string;
  readonly lvlText?: string;
  readonly pStyle?: string;
  readonly start?: number;
  readonly lvlRestart?: number;
}

export interface AbstractNum {
  readonly abstractNumId: number;
  readonly levels: readonly AbstractNumLevel[];
}

export interface NumLvlOverride {
  readonly ilvl: number;
  readonly startOverride?: number;
}

export interface Num {
  readonly numId: number;
  readonly abstractNumId: number;
  readonly lvlOverride?: readonly NumLvlOverride[];
}

export interface NumberingMap {
  readonly nums: ReadonlyMap<number, Num>;
  readonly abstractNums: ReadonlyMap<number, AbstractNum>;
  readonly pStyleToNumId: ReadonlyMap<string, number>;
  readonly pStyleToIlvl: ReadonlyMap<string, number>;
  // ilvl at which 'article' starts: ARCAT-style=1, CPI-style=3
  readonly articleIlvl: number;
  // numIds whose abstractNum links a multi-level pStyle ladder (>=3 levels) —
  // a numbering definition shaped like a spec, not a flat list. Lets Signal 1
  // accept ilvl=0 as 'part' when the "PART n" prefix is numbering-generated
  // (ARCAT: literal text is just "GENERAL") without re-opening the
  // LibreOffice generic-<ol> false positive.
  readonly specShapedNumIds: ReadonlySet<number>;
}

// ─── styles.xml ───────────────────────────────────────────────────────────────

export interface StyleNumPr {
  readonly numId: number;
  readonly ilvl: number;
}

export interface StyleInfo {
  readonly styleId: string;
  readonly name: string;
  readonly basedOn?: string;
  readonly numPr?: StyleNumPr;
  // numId=0 in the style's own pPr explicitly suppresses inherited numbering.
  // Clippit ListItemRetriever stops basedOn chain traversal here.
  readonly suppressesNumbering?: boolean;
  readonly isVanish?: boolean;
  readonly outlineLvl?: number;
  readonly next?: string;
}

export interface StyleMap {
  readonly styles: ReadonlyMap<string, StyleInfo>;
  // Effective numPr for each style after walking basedOn chain
  readonly resolvedNumPr: ReadonlyMap<string, StyleNumPr>;
  readonly vanishStyleIds: ReadonlySet<string>;
  readonly vanishCharStyleIds: ReadonlySet<string>;
}

// ─── document.xml ─────────────────────────────────────────────────────────────

export interface DocxParagraph {
  readonly text: string;
  readonly styleId?: string;
  readonly numId?: number; // 0 = suppress numbering (OOXML sentinel)
  readonly ilvl?: number;
  readonly leftIndent?: number; // twips (1/1440 inch)
  readonly outlineLvl?: number;
  readonly isVanish: boolean;
  readonly sourceFacts?: SourceFacts;
}

// ─── inference.ts output ──────────────────────────────────────────────────────

export interface SignalConflict {
  readonly signal: 1 | 2 | 3 | 4 | 5;
  readonly reportedIlvl: number;
  readonly reportedNodeType: NodeType;
}

export interface ClassifiedParagraph {
  readonly paragraph: DocxParagraph;
  // Canonical normalized ilvl: part=0, article=1, pr1=2, ..., pr7=8
  readonly resolvedIlvl: number;
  readonly nodeType: NodeType;
  readonly signalUsed: 1 | 2 | 3 | 4 | 5;
  readonly conflicts: readonly SignalConflict[];
  readonly isVanish: boolean;
  // A genuine specifier note (banner text or a note-named style) — editorial
  // metadata rendered as [NOTE]. Distinct from isVanish (merely hidden): hidden
  // non-note content is a suppressed 'continuation', a note renders (#296).
  // Absent === not a note.
  readonly isNote?: boolean;
}
