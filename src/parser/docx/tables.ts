// DOCX table extractor (#293): scans word/document.xml, table-scoped, independently
// of parseDocument's paragraph walk. Classifies each body-level w:tbl as hidden (every
// text-bearing cell paragraph is vanish) or visible, retaining hidden tables as
// plain-text grids out-of-band for future change-management (ADR-038). Visible tables
// are counted only — not yet modeled into the spec tree (surfaced by the caller as a
// table-content-skipped warning).

import { ParserError } from '../error.js';
import { createDocumentXmlParser, toArray } from './xml-utils.js';
import { extractParagraphText, isParagraphVanish } from './document.js';
import type { RetainedTable } from '../../ast/index.js';
import type { StyleMap } from './types.js';

// Shares document.ts's exact document.xml parser config (createDocumentXmlParser, see
// xml-utils for the #22/#120 rationale) — adding the table-structure tags to isArray — so
// the reused extractParagraphText and isParagraphVanish behave identically here.
const xmlParser = createDocumentXmlParser(['w:tbl', 'w:tr', 'w:tc', 'w:p', 'w:r', 'w:hyperlink']);

interface TableCellParagraph {
  readonly text: string;
  readonly isVanish: boolean;
}

interface TableCell {
  readonly paragraphs: readonly TableCellParagraph[];
}

type TableRow = readonly TableCell[];

type TableClassification =
  | { readonly kind: 'visible' }
  | { readonly kind: 'hidden'; readonly table: RetainedTable };

export interface TableExtractionResult {
  readonly hiddenTables: readonly RetainedTable[];
  readonly visibleCount: number;
}

function parseTablesXml(xml: string): Record<string, unknown> {
  try {
    return xmlParser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new ParserError('failed to scan tables in word/document.xml', {
      code: 'DOCX_TABLE_XML_INVALID',
      cause: err,
    });
  }
}

// Direct w:body children only — a w:tbl nested inside a cell is not walked.
// KNOWN AMBIGUITY: see tables.test.ts (out of scope for #293).
function findTopLevelTables(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  return toArray<Record<string, unknown>>(
    body['w:tbl'] as readonly Record<string, unknown>[] | undefined
  );
}

function parseTableCellParagraph(
  p: Record<string, unknown>,
  styleMap: StyleMap
): TableCellParagraph {
  return { text: extractParagraphText(p), isVanish: isParagraphVanish(p, styleMap) };
}

function parseTableCell(tc: Record<string, unknown>, styleMap: StyleMap): TableCell {
  return {
    paragraphs: toArray<Record<string, unknown>>(
      tc['w:p'] as readonly Record<string, unknown>[] | undefined
    ).map((p) => parseTableCellParagraph(p, styleMap)),
  };
}

function parseTableCells(tr: Record<string, unknown>, styleMap: StyleMap): TableRow {
  return toArray<Record<string, unknown>>(
    tr['w:tc'] as readonly Record<string, unknown>[] | undefined
  ).map((tc) => parseTableCell(tc, styleMap));
}

function parseTableRows(tbl: Record<string, unknown>, styleMap: StyleMap): readonly TableRow[] {
  return toArray<Record<string, unknown>>(
    tbl['w:tr'] as readonly Record<string, unknown>[] | undefined
  ).map((tr) => parseTableCells(tr, styleMap));
}

function cellText(cell: TableCell): string {
  return cell.paragraphs
    .map((p) => p.text)
    .join('\n')
    .trim();
}

function buildRetainedTable(rows: readonly TableRow[]): RetainedTable {
  return { rows: rows.map((row) => row.map(cellText)) };
}

// No text-bearing evidence anywhere in the table → visible (an empty table has
// nothing to hide). All evidence vanish → hidden. Any visible evidence → visible,
// even if some cells are vanish (mixed content is real, retained content).
function classifyTable(rows: readonly TableRow[]): TableClassification {
  const evidence = rows
    .flatMap((row) => row.flatMap((cell) => cell.paragraphs))
    .filter((p) => p.text.trim().length > 0);
  if (evidence.length > 0 && evidence.every((p) => p.isVanish)) {
    return { kind: 'hidden', table: buildRetainedTable(rows) };
  }
  return { kind: 'visible' };
}

export function extractTables(xml: string, styleMap: StyleMap): TableExtractionResult {
  const parsed = parseTablesXml(xml);
  const doc = parsed['w:document'] as Record<string, unknown> | undefined;
  const body = doc?.['w:body'] as Record<string, unknown> | undefined;
  if (!body) return { hiddenTables: [], visibleCount: 0 };

  const classifications = findTopLevelTables(body).map((tbl) =>
    classifyTable(parseTableRows(tbl, styleMap))
  );
  return {
    hiddenTables: classifications.flatMap((c) => (c.kind === 'hidden' ? [c.table] : [])),
    visibleCount: classifications.filter((c) => c.kind === 'visible').length,
  };
}
