// DrawingML theme font extraction for DOCX theme resolution.
// Parses word/theme/theme1.xml (a:theme/a:themeElements/a:fontScheme).
//
// NOTE: Strict discovery should follow the officeDocument→theme relationship in
// word/_rels/document.xml.rels; reading theme1.xml by convention is an
// adequate approximation for spec-import use-cases (themeFontLang is out of scope).
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { ParserError } from '../error.js';
import { asRecord, extractAttrStr, compact } from './xml-utils.js';

// ─── types ────────────────────────────────────────────────────────────────────

export interface ThemeFontSlot {
  readonly latin?: string;
  readonly ea?: string;
  readonly cs?: string;
}

export interface ThemeFonts {
  readonly major: ThemeFontSlot;
  readonly minor: ThemeFontSlot;
}

// ─── ST_Theme token → (major|minor, latin|ea|cs) ────────────────────────────
// Per ECMA-376 §20.1.10.86 ST_Theme: the TOKEN identifies both the major/minor
// tier AND the script slot, independent of which w:rFonts attribute carries it.
// E.g. eastAsiaTheme="minorHAnsi" → minorFont.latin (not minor.ea).
// typeface="" (stock theme ships empty ea/cs) is treated as absent throughout.

export type ScriptSlot = 'latin' | 'ea' | 'cs';

interface TokenResolution {
  readonly tier: 'major' | 'minor';
  readonly slot: ScriptSlot;
}

const TOKEN_MAP: Readonly<Record<string, TokenResolution>> = {
  majorAscii: { tier: 'major', slot: 'latin' },
  majorHAnsi: { tier: 'major', slot: 'latin' },
  minorAscii: { tier: 'minor', slot: 'latin' },
  minorHAnsi: { tier: 'minor', slot: 'latin' },
  majorEastAsia: { tier: 'major', slot: 'ea' },
  minorEastAsia: { tier: 'minor', slot: 'ea' },
  majorBidi: { tier: 'major', slot: 'cs' },
  minorBidi: { tier: 'minor', slot: 'cs' },
};

/**
 * Resolve a ST_Theme token to a concrete typeface string using a parsed ThemeFonts.
 * Returns undefined when: token is unknown, no theme available, or typeface is empty.
 */
export function resolveToken(token: string, fonts: ThemeFonts): string | undefined {
  const res = TOKEN_MAP[token];
  if (!res) return undefined;
  return fonts[res.tier][res.slot];
}

// ─── XML parser ───────────────────────────────────────────────────────────────

const EMPTY_THEME_FONTS: ThemeFonts = { major: {}, minor: {} };

const themeParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
});

function validateThemeXml(themeXml: string): void {
  try {
    // SyntaxValidator.validate throws a ValidationError on malformed XML and
    // returns true otherwise — it never returns an error object at runtime, so
    // the throw is the only failure path. theme.test.ts pins this behavior.
    SyntaxValidator.validate(themeXml);
  } catch (err) {
    throw new ParserError('failed to parse theme XML', { cause: err });
  }
}

function typeface(el: Record<string, unknown> | undefined): string | undefined {
  if (!el) return undefined;
  const v = extractAttrStr(el, '@_typeface');
  return v === '' ? undefined : v;
}

function parseFontSlot(fontEl: Record<string, unknown> | undefined): ThemeFontSlot {
  if (!fontEl) return {};
  return compact({
    latin: typeface(asRecord(fontEl['a:latin'])),
    ea: typeface(asRecord(fontEl['a:ea'])),
    cs: typeface(asRecord(fontEl['a:cs'])),
  }) as ThemeFontSlot;
}

/**
 * Parse word/theme/theme1.xml and extract the major/minor font scheme.
 * Returns empty ThemeFonts on missing/malformed structure (never throws on
 * well-formed XML that simply lacks a fontScheme).
 * Throws ParserError when the XML is structurally invalid (e.g. mismatched tags).
 */
export function parseThemeFonts(themeXml: string): ThemeFonts {
  // Unlike numbering/styles parsing, the theme part is optional + externally
  // authored, so keep validation enabled and surface broken XML with context.
  validateThemeXml(themeXml);

  let parsed: unknown;
  try {
    parsed = themeParser.parse(themeXml);
  } catch (err) {
    throw new ParserError('failed to parse theme XML', { cause: err });
  }
  const parsedRoot = asRecord(parsed);
  const root = parsedRoot ? asRecord(parsedRoot['a:theme']) : undefined;
  if (!root) return EMPTY_THEME_FONTS;
  const elements = asRecord(root['a:themeElements']);
  if (!elements) return EMPTY_THEME_FONTS;
  const fontScheme = asRecord(elements['a:fontScheme']);
  if (!fontScheme) return EMPTY_THEME_FONTS;

  const majorRaw = asRecord(fontScheme['a:majorFont']);
  const minorRaw = asRecord(fontScheme['a:minorFont']);
  return {
    major: compact(parseFontSlot(majorRaw)),
    minor: compact(parseFontSlot(minorRaw)),
  };
}
