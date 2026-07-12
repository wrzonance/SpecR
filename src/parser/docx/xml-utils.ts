// Shared OOXML attribute extraction helpers for fast-xml-parser output.
// fast-xml-parser represents w:val attributes as { '@_w:val': string | number }.

import { XMLParser } from 'fast-xml-parser';

// The word/document.xml full-fidelity parser config, shared by every scanner that reads
// document.xml runs/paragraphs (document.ts, tables.ts) so the run/text/vanish helpers
// they reuse (extractParagraphText, isParagraphVanish) behave identically on every path —
// only the isArray tag set varies per scanner. Two hand-copied configs could drift and
// make a reused helper silently diverge on one path (Codex #293).
//
// Entity audit (issue #22): fxp v5 does not resolve custom or recursive entity
// declarations — undefined/recursive &refs; are returned verbatim, not expanded (no
// billion-laughs risk). processEntities: true is required: OOXML text uses &amp; &lt;
// &gt; for ampersands and angle brackets; false would corrupt those characters in text.
// trimValues: false preserves leading/trailing spaces in w:t nodes — trimming would
// corrupt concatenated paragraph text across adjacent runs. parseTagValue: false keeps
// w:t text as strings (#120): fxp's default numeric coercion turns a bare-integer run
// (<w:t>9</w:t>) into the number 9, which extractRunText cannot read and silently drops —
// deleting digits Word split across runs, e.g. "09 91 26" stored as ["09 ", "9", "1 26"].
export function createDocumentXmlParser(isArrayTags: readonly string[]): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: true,
    trimValues: false,
    parseTagValue: false,
    isArray: (name) => isArrayTags.includes(name),
  });
}

export function getAttrVal(obj: unknown): string {
  if (obj !== null && typeof obj === 'object' && '@_w:val' in obj) {
    const v = (obj as Record<string, unknown>)['@_w:val'];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export function getAttrNumVal(obj: unknown): number {
  const n = parseInt(getAttrVal(obj), 10);
  return isNaN(n) ? 0 : n;
}

// Safely extract a top-level attribute value from a parsed XML record.
// fast-xml-parser stores w:abstractNumId as '@_w:abstractNumId' with string or number value.
export function extractAttrStr(record: Record<string, unknown>, key: string): string {
  const val = record[key];
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

export function toArray<T>(val: T | readonly T[] | undefined): readonly T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? (val as readonly T[]) : [val as T];
}

// Narrow an unknown fast-xml-parser node to a Record, or undefined if not an object.
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

// Keep only defined keys so absent properties are not stored as explicit `undefined`.
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
