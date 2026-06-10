// Pure helpers that extract a single OOXML style's own rPr / pPr visual properties
// into the RunProperties / ParagraphProperties shapes.  No cascade — no DB — no I/O.
import { getAttrVal, extractAttrStr, asRecord } from './xml-utils.js';
import type { RunProperties, ParagraphProperties } from '../../ast/types.js';

// ─── internal helpers ─────────────────────────────────────────────────────────

// Numeric attribute on a nested element (e.g. '@_w:left'); undefined if absent/non-numeric.
function numAttr(el: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!el) return undefined;
  const s = extractAttrStr(el, key);
  if (s === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

// String attribute (e.g. '@_w:ascii'); undefined if absent/empty.
function strAttr(el: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!el) return undefined;
  const s = extractAttrStr(el, key);
  return s === '' ? undefined : s;
}

// OOXML toggle: absent → undefined (inherit); val '0'/'false'/'off' → false; else → true.
function toggle(el: unknown): boolean | undefined {
  if (el === undefined) return undefined;
  const obj = asRecord(el);
  const v = obj ? extractAttrStr(obj, '@_w:val') : '';
  return v !== '0' && v !== 'false' && v !== 'off';
}

// Keep only defined keys so absent properties are not stored as explicit `undefined`.
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// Compact a built sub-object; collapse to undefined when no key survived
// (an all-absent nested element must not appear as an empty {} in the payload).
function subObj<T extends object>(built: Partial<T>): T | undefined {
  const c = compact(built as Record<string, unknown>);
  return Object.keys(c).length ? (c as T) : undefined;
}

// ─── public API ───────────────────────────────────────────────────────────────

export function extractRunProps(rPr: Record<string, unknown> | undefined): RunProperties {
  if (!rPr) return {};
  const rFontsEl = asRecord(rPr['w:rFonts']);
  const rFonts = rFontsEl
    ? subObj({
        ascii: strAttr(rFontsEl, '@_w:ascii'),
        hAnsi: strAttr(rFontsEl, '@_w:hAnsi'),
        cs: strAttr(rFontsEl, '@_w:cs'),
        eastAsia: strAttr(rFontsEl, '@_w:eastAsia'),
      })
    : undefined;
  return compact({
    rFonts,
    sz: numAttr(asRecord(rPr['w:sz']), '@_w:val'),
    b: toggle(rPr['w:b']),
    i: toggle(rPr['w:i']),
    caps: toggle(rPr['w:caps']),
    smallCaps: toggle(rPr['w:smallCaps']),
    strike: toggle(rPr['w:strike']),
    u: getAttrVal(rPr['w:u']) || undefined,
    color: getAttrVal(rPr['w:color']) || undefined,
    highlight: getAttrVal(rPr['w:highlight']) || undefined,
  }) as RunProperties;
}

export function extractParaProps(pPr: Record<string, unknown> | undefined): ParagraphProperties {
  if (!pPr) return {};
  const sp = asRecord(pPr['w:spacing']);
  const ind = asRecord(pPr['w:ind']);
  // w:contextualSpacing is a w:pPr SIBLING element, but the schema normalizes it
  // under spacing — so it must be folded in even when w:spacing itself is absent.
  const spacing = subObj({
    before: numAttr(sp, '@_w:before'),
    after: numAttr(sp, '@_w:after'),
    line: numAttr(sp, '@_w:line'),
    lineRule: strAttr(sp, '@_w:lineRule'),
    contextualSpacing: toggle(pPr['w:contextualSpacing']),
  });
  const indent = subObj({
    left: numAttr(ind, '@_w:left'),
    right: numAttr(ind, '@_w:right'),
    firstLine: numAttr(ind, '@_w:firstLine'),
    hanging: numAttr(ind, '@_w:hanging'),
  });
  return compact({
    spacing,
    ind: indent,
    jc: getAttrVal(pPr['w:jc']) || undefined,
  }) as ParagraphProperties;
}
