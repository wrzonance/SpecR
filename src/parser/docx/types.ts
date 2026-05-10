// OOXML intermediate types — normalized shapes used across the DOCX parser pipeline.

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
  // ilvl at which 'article' starts: ARCAT-style=1, MASTERSPEC-style=3
  readonly articleIlvl: number;
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
  readonly isVanish?: boolean;
  readonly outlineLvl?: number;
  readonly next?: string;
}

export interface StyleMap {
  readonly styles: ReadonlyMap<string, StyleInfo>;
  // Effective numPr for each style after walking basedOn chain
  readonly resolvedNumPr: ReadonlyMap<string, StyleNumPr>;
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
}
