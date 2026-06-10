// Pure helpers that extract a single OOXML style's own rPr / pPr visual properties
// into the RunProperties / ParagraphProperties shapes.  No cascade — no DB — no I/O.
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { getAttrVal, extractAttrStr, asRecord, toArray } from './xml-utils.js';
import type { RunProperties, ParagraphProperties, StyleProperties } from '../../ast/types.js';

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

// ─── styles.xml full-parse for cascade resolution ────────────────────────────

// Stateless between parse() calls — safe as a module-level singleton.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => name === 'w:style',
});

export interface RawStyle {
  readonly basedOn?: string;
  readonly own: StyleProperties;
}

export interface ParsedStyles {
  readonly docDefaults: StyleProperties;
  readonly styles: ReadonlyMap<string, RawStyle>;
}

// Assemble a StyleProperties from optional rPr + pPr element objects.
function ownProps(
  rPr: Record<string, unknown> | undefined,
  pPr: Record<string, unknown> | undefined
): StyleProperties {
  return compact({
    rPr: subObj(extractRunProps(rPr)),
    pPr: subObj(extractParaProps(pPr)),
  }) as StyleProperties;
}

// Extract docDefaults from the w:docDefaults element.
function parseDocDefaults(root: Record<string, unknown>): StyleProperties {
  const dd = asRecord(root['w:docDefaults']);
  const ddRpr = asRecord(asRecord(dd?.['w:rPrDefault'])?.['w:rPr']);
  const ddPpr = asRecord(asRecord(dd?.['w:pPrDefault'])?.['w:pPr']);
  return ownProps(ddRpr, ddPpr);
}

// Parse a single w:style element into a RawStyle, or undefined if it should be skipped.
function parseOneStyle(raw: unknown): readonly [string, RawStyle] | undefined {
  const s = asRecord(raw);
  if (!s) return undefined;
  if ((extractAttrStr(s, '@_w:type') || 'paragraph') !== 'paragraph') return undefined;
  const styleId = extractAttrStr(s, '@_w:styleId');
  if (!styleId) return undefined;
  const basedOnVal = getAttrVal(s['w:basedOn']) || undefined;
  const own = ownProps(asRecord(s['w:rPr']), asRecord(s['w:pPr']));
  const entry: RawStyle = basedOnVal !== undefined ? { basedOn: basedOnVal, own } : { own };
  return [styleId, entry];
}

// ─── style cascade resolution ─────────────────────────────────────────────────

// Plain object — not null, not array (arrays are last-wins values, not deep-merged).
function isPlainObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// Deep-merge `over` onto `base`: value/toggle props last-wins; nested plain objects merge.
// Pure — never mutates base or over.
function mergeRecord(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  return Object.entries(over).reduce<Record<string, unknown>>(
    (acc, [k, v]) => {
      if (v === undefined) return acc;
      const b = acc[k];
      return { ...acc, [k]: isPlainObj(b) && isPlainObj(v) ? mergeRecord(b, v) : v };
    },
    { ...base }
  );
}

export function mergeStyleProps(base: StyleProperties, over: StyleProperties): StyleProperties {
  return mergeRecord(base, over) as StyleProperties;
}

// Build [self, parent, grandparent, ...] following basedOn links.
// Stops on cycle / missing target. The `seen` Set guarantees termination —
// each iteration adds a new id or breaks.
function styleChain(styleId: string, parsed: ParsedStyles): readonly StyleProperties[] {
  const seen = new Set<string>();
  const layers: StyleProperties[] = [];
  let id: string | undefined = styleId;
  while (id !== undefined && !seen.has(id)) {
    const s = parsed.styles.get(id);
    if (!s) break;
    seen.add(id);
    layers.push(s.own);
    id = s.basedOn;
  }
  return layers;
}

// Resolve the full effective style: docDefaults base, ancestors furthest-first down to
// the style itself (closest wins).
export function resolveStyleChain(styleId: string, parsed: ParsedStyles): StyleProperties {
  return styleChain(styleId, parsed).reduceRight(
    (acc, layer) => mergeStyleProps(acc, layer),
    parsed.docDefaults
  );
}

export function parseStylesFull(xml: string): ParsedStyles {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse styles.xml for cascade resolution', { cause: err });
  }
  const root = asRecord((parsed as Record<string, unknown>)['w:styles']);
  if (!root) return { docDefaults: {}, styles: new Map() };

  const docDefaults = parseDocDefaults(root);
  const styles = new Map<string, RawStyle>();
  for (const raw of toArray(root['w:style'] as readonly unknown[] | undefined)) {
    const result = parseOneStyle(raw);
    if (result) styles.set(result[0], result[1]);
  }
  return { docDefaults, styles };
}
