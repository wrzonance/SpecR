// Shared OOXML attribute extraction helpers for fast-xml-parser output.
// fast-xml-parser represents w:val attributes as { '@_w:val': string | number }.

import { XMLParser } from 'fast-xml-parser';
// XMLBuilder is flagged deprecated (relocated to the separate
// `fast-xml-builder` package in fast-xml-parser 5.x) but still ships and
// works in the pinned version. We keep using it rather than take on a whole
// new dependency — added attack surface — for a single reserialize helper.
// Same tradeoff as core-metadata.ts's XMLValidator import. Revisit if it is
// removed upstream.
// eslint-disable-next-line sonarjs/deprecation -- intentional: see note above
import { XMLBuilder } from 'fast-xml-parser';

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

// Ordered-mode capture config for body-level objects SpecR round-trips as an
// opaque blob (#300 body object model, ADR-072: `w:tbl` tables, textbox
// `w:drawing`/`w:pict` content). Same entity/whitespace/#120 guarantees as
// createDocumentXmlParser above, plus preserveOrder: true — required so a
// table/textbox's own children stay in true document order instead of being
// grouped by tag name, which is what lets createOrderedDocumentXmlBuilder
// reserialize the captured node(s) byte-for-byte. Mirrors the preserveOrder
// config already established in merge/extract.ts, source-facts.ts, and
// header-footer-run-order.ts for the same class of ordering problem.
export function createOrderedDocumentXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    processEntities: true,
    trimValues: false,
    parseTagValue: false,
    preserveOrder: true,
  });
}

// Reserializes a createOrderedDocumentXmlParser() node tree back to XML — the
// other half of the ADR-072 blob round-trip (capture now, re-emit later from
// generator/WS2's future bridge). suppressEmptyNode: true is LOAD-BEARING for
// byte-identical fidelity: a self-closing empty OOXML element (e.g.
// `<w:tcW .../>`) parses to a node with an empty children array; without this
// flag the builder re-emits it as an explicit open/close pair
// (`<w:tcW ...></w:tcW>`) — semantically identical to any DOCX consumer, but
// not the same bytes, which breaks the byte-identical guarantee this blob
// format promises (spike measured an 18335->21005 char drift on a real table
// fixture without it — see xml-utils.test.ts's negative-control test).
// eslint-disable-next-line sonarjs/deprecation -- see XMLBuilder import note
export function createOrderedDocumentXmlBuilder(): XMLBuilder {
  // eslint-disable-next-line sonarjs/deprecation -- see XMLBuilder import note
  return new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    preserveOrder: true,
    suppressEmptyNode: true,
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
