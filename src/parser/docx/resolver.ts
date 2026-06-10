// Pure helpers that extract a single OOXML style's own rPr / pPr visual properties
// into the RunProperties / ParagraphProperties shapes.  No cascade — no DB — no I/O.
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { getAttrVal, extractAttrStr, asRecord, toArray, compact } from './xml-utils.js';
import type {
  RunProperties,
  ParagraphProperties,
  StyleProperties,
  NumberingDef,
} from '../../ast/types.js';
import type { StyleMap, NumberingMap } from './types.js';
import { buildStyleMap } from './styles.js';
import { buildNumberingMap } from './numbering.js';
import { StylePropertiesSchema } from '../../ast/index.js';
import { parseThemeFonts, resolveToken } from './theme.js';
import type { ThemeFonts } from './theme.js';

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
  // ECMA-376 §17.3.2.26: w:rFonts carries both direct (ascii/hAnsi/cs/eastAsia) and
  // theme (asciiTheme/hAnsiTheme/cstheme/eastAsiaTheme) attributes.
  // Theme attrs are preserved here as provenance; resolution happens in resolveStyleCascade.
  // Note OOXML casing: w:cstheme (lowercase 't') per ECMA-376 §17.18.96 ST_Theme.
  const rFonts = rFontsEl
    ? subObj({
        ascii: strAttr(rFontsEl, '@_w:ascii'),
        hAnsi: strAttr(rFontsEl, '@_w:hAnsi'),
        cs: strAttr(rFontsEl, '@_w:cs'),
        eastAsia: strAttr(rFontsEl, '@_w:eastAsia'),
        asciiTheme: strAttr(rFontsEl, '@_w:asciiTheme'),
        hAnsiTheme: strAttr(rFontsEl, '@_w:hAnsiTheme'),
        cstheme: strAttr(rFontsEl, '@_w:cstheme'),
        eastAsiaTheme: strAttr(rFontsEl, '@_w:eastAsiaTheme'),
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

// Font pair-slots: each (direct, theme) pair is ONE logical slot per MS-OI29500.
// When a closer cascade level specifies either flavor of a pair, the other flavor
// from an earlier level must be cleared — otherwise the generic merge would leave
// an inherited theme attr next to a child's direct attr, which is wrong.
const RFONT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['ascii', 'asciiTheme'],
  ['hAnsi', 'hAnsiTheme'],
  ['cs', 'cstheme'],
  ['eastAsia', 'eastAsiaTheme'],
] as const;

// Merge two rFonts objects with pair-slot semantics.
// "over" represents a closer (child) cascade level.
// For each pair: if over specifies either member, clear both from base before applying over.
function mergeRFonts(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  // For each pair-slot touched by `over`, clear both flavors from base first.
  const keysToDelete = new Set<string>();
  for (const [direct, theme] of RFONT_PAIRS) {
    if (direct in over || theme in over) {
      keysToDelete.add(direct);
      keysToDelete.add(theme);
    }
  }
  const cleared = Object.fromEntries(Object.entries(base).filter(([k]) => !keysToDelete.has(k)));
  return { ...cleared, ...over };
}

// Deep-merge `over` onto `base`: value/toggle props last-wins; nested plain objects merge.
// rFonts receives specialized pair-slot merge (pair-slot clearing per MS-OI29500).
// Pure — never mutates base or over.
function mergeRecord(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  key?: string
): Record<string, unknown> {
  return Object.entries(over).reduce<Record<string, unknown>>(
    (acc, [k, v]) => {
      if (v === undefined) return acc;
      const b = acc[k];
      if (isPlainObj(b) && isPlainObj(v)) {
        // Path assumption: only fires for rPr immediately under the root StyleProperties
        // object. A deeper rPr (e.g. a future numbering-level rPr) would need its own
        // mergeRecord call with key='rPr'. Revisit as a mergeStrategy map in #154.
        const merged = key === 'rPr' && k === 'rFonts' ? mergeRFonts(b, v) : mergeRecord(b, v, k);
        return { ...acc, [k]: merged };
      }
      return { ...acc, [k]: v };
    },
    { ...base }
  );
}

export function mergeStyleProps(base: StyleProperties, over: StyleProperties): StyleProperties {
  return mergeRecord(base, over) as StyleProperties;
}

// ─── theme font resolution pass ───────────────────────────────────────────────

// Per ECMA-376 §17.3.2.26: within one w:rFonts element, the *Theme attr supersedes
// its direct counterpart. Resolution fills the concrete slot only when the theme
// resolves to a non-empty typeface; preserves the *Theme key as provenance.
// Called after cascade resolution, before schema validation.
const RFONT_THEME_CARRYING_ATTRS: ReadonlyArray<{
  readonly themeKey: string;
  readonly directKey: string;
}> = [
  { themeKey: 'asciiTheme', directKey: 'ascii' },
  { themeKey: 'hAnsiTheme', directKey: 'hAnsi' },
  { themeKey: 'cstheme', directKey: 'cs' },
  { themeKey: 'eastAsiaTheme', directKey: 'eastAsia' },
];

function resolveRFonts(
  rFonts: Record<string, unknown>,
  fonts: ThemeFonts
): Record<string, unknown> {
  let result = { ...rFonts };
  for (const { themeKey, directKey } of RFONT_THEME_CARRYING_ATTRS) {
    const token = result[themeKey];
    if (typeof token !== 'string') continue;
    const resolved = resolveToken(token, fonts);
    if (resolved !== undefined) {
      // Theme supersedes direct: overwrite the concrete slot with the resolved value.
      result = { ...result, [directKey]: resolved };
    }
  }
  return result;
}

function applyThemeToStyleProps(props: StyleProperties, fonts: ThemeFonts): StyleProperties {
  const rPr = props.rPr;
  if (!rPr) return props;
  const rFonts = (rPr as Record<string, unknown>)['rFonts'];
  if (!isPlainObj(rFonts)) return props;
  const resolved = resolveRFonts(rFonts, fonts);
  return {
    ...props,
    rPr: { ...(rPr as Record<string, unknown>), rFonts: resolved } as typeof rPr,
  };
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

// ─── numbering context resolution ────────────────────────────────────────────

/**
 * Resolve the numbering context (ilvl + level format) for a style by looking up
 * its effective numPr (already resolved through the basedOn chain in StyleMap)
 * and cross-referencing the abstractNum level definition in NumberingMap.
 *
 * Returns undefined when the style has no resolved numPr.
 * Returns at least { ilvl } when the numId is not present in numbering.xml
 * (lvlOverride / startOverride handling is intentionally deferred).
 */
export function resolveNumberingFor(
  styleId: string,
  styleMap: StyleMap,
  numberingMap: NumberingMap
): NumberingDef | undefined {
  const np = styleMap.resolvedNumPr.get(styleId);
  if (!np) return undefined;
  const num = numberingMap.nums.get(np.numId);
  const an = num ? numberingMap.abstractNums.get(num.abstractNumId) : undefined;
  const lvl = an?.levels.find((l) => l.ilvl === np.ilvl);
  // (lvlOverride startOverride not applied here — deferred)
  return compact({
    ilvl: np.ilvl,
    numFmt: lvl?.numFmt,
    lvlText: lvl?.lvlText,
    start: lvl?.start,
  }) as NumberingDef;
}

// ─── public entry point ───────────────────────────────────────────────────────

/**
 * Resolve the effective StyleProperties for every paragraph style in styles.xml.
 * Applies docDefaults → basedOn chain → own-props cascade, then merges any
 * numbering context resolved from numbering.xml.
 *
 * When themeXml is provided (word/theme/theme1.xml), theme font tokens in rFonts
 * (asciiTheme/hAnsiTheme/cstheme/eastAsiaTheme) are resolved to concrete typefaces
 * per ECMA-376 §17.3.2.26: the theme attr supersedes its direct counterpart within
 * the same element; theme attrs are kept in the payload as provenance.
 *
 * Every produced value is validated through StylePropertiesSchema — guarantees
 * JSON-safe, schema-valid output at the module boundary.
 *
 * NOTE: parseStylesFull and buildStyleMap each parse stylesXml independently
 * (visual props vs structural numPr). Unifying into one parse is a worthwhile
 * refactor when the inference pipeline is next touched — deferred, not an oversight.
 */
export function resolveStyleCascade(
  stylesXml: string,
  numberingXml?: string | null,
  themeXml?: string | null
): Map<string, StyleProperties> {
  const parsed = parseStylesFull(stylesXml);
  const styleMap = buildStyleMap(stylesXml);
  const numberingMap = numberingXml ? buildNumberingMap(numberingXml) : undefined;
  const themeFonts = themeXml ? parseThemeFonts(themeXml) : undefined;
  const out = new Map<string, StyleProperties>();
  for (const styleId of parsed.styles.keys()) {
    const visual = resolveStyleChain(styleId, parsed);
    const numbering = numberingMap
      ? resolveNumberingFor(styleId, styleMap, numberingMap)
      : undefined;
    const cascaded = numbering ? mergeStyleProps(visual, { numbering }) : visual;
    const eff = themeFonts ? applyThemeToStyleProps(cascaded, themeFonts) : cascaded;
    // Validate at the boundary — every produced value is schema-valid + JSON-safe.
    out.set(styleId, StylePropertiesSchema.parse(eff));
  }
  return out;
}
