import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { getAttrVal, getAttrNumVal, extractAttrStr, toArray } from './xml-utils.js';
import type { AbstractNum, AbstractNumLevel, Num, NumberingMap, NumLvlOverride } from './types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  isArray: (name) => ['w:abstractNum', 'w:lvl', 'w:num', 'w:lvlOverride'].includes(name),
});

function parseLvl(raw: Record<string, unknown>, ilvl: number): AbstractNumLevel {
  const lvlText = getAttrVal(raw['w:lvlText']);
  const pStyle = getAttrVal(raw['w:pStyle']);
  const start = raw['w:start'] !== undefined ? getAttrNumVal(raw['w:start']) : undefined;
  const lvlRestart =
    raw['w:lvlRestart'] !== undefined ? getAttrNumVal(raw['w:lvlRestart']) : undefined;
  return {
    ilvl,
    numFmt: getAttrVal(raw['w:numFmt']) || 'decimal',
    ...(lvlText ? { lvlText } : {}),
    ...(pStyle ? { pStyle } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(lvlRestart !== undefined ? { lvlRestart } : {}),
  };
}

function parseAbstractNums(rawList: readonly unknown[]): ReadonlyMap<number, AbstractNum> {
  const map = new Map<number, AbstractNum>();
  for (const raw of rawList) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = parseInt(extractAttrStr(r, '@_w:abstractNumId'), 10);
    if (isNaN(id)) continue;
    const levels = toArray(r['w:lvl'] as readonly unknown[] | undefined)
      .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
      .map((l) => parseLvl(l, parseInt(extractAttrStr(l, '@_w:ilvl') || '0', 10)));
    map.set(id, { abstractNumId: id, levels });
  }
  return map;
}

function parseNums(rawList: readonly unknown[]): ReadonlyMap<number, Num> {
  const map = new Map<number, Num>();
  for (const raw of rawList) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const numId = parseInt(extractAttrStr(r, '@_w:numId'), 10);
    if (isNaN(numId)) continue;
    const abstractNumId = parseInt(getAttrVal(r['w:abstractNumId']), 10);
    if (isNaN(abstractNumId)) continue;
    const overrides = toArray(r['w:lvlOverride'] as readonly unknown[] | undefined)
      .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
      .map((l): NumLvlOverride => {
        const startRaw = getAttrVal(l['w:startOverride']);
        const startOverride = startRaw ? parseInt(startRaw, 10) : NaN;
        return {
          ilvl: parseInt(extractAttrStr(l, '@_w:ilvl') || '0', 10),
          ...(!isNaN(startOverride) ? { startOverride } : {}),
        };
      });
    map.set(numId, {
      numId,
      abstractNumId,
      ...(overrides.length > 0 ? { lvlOverride: overrides } : {}),
    });
  }
  return map;
}

function buildPStyleMaps(
  nums: ReadonlyMap<number, Num>,
  abstractNums: ReadonlyMap<number, AbstractNum>
): { pStyleToNumId: Map<string, number>; pStyleToIlvl: Map<string, number> } {
  const pStyleToNumId = new Map<string, number>();
  const pStyleToIlvl = new Map<string, number>();
  for (const num of nums.values()) {
    const an = abstractNums.get(num.abstractNumId);
    if (!an) continue;
    for (const lvl of an.levels) {
      if (lvl.pStyle) {
        pStyleToNumId.set(lvl.pStyle, num.numId);
        pStyleToIlvl.set(lvl.pStyle, lvl.ilvl);
      }
    }
  }
  return { pStyleToNumId, pStyleToIlvl };
}

const SPEC_SHAPED_MIN_LINKED_LEVELS = 3;
// Word renders the ilvl=0 prefix from lvlText; a leading "PART" immediately followed
// by the level field (%1) means the numbering itself generates "PART n", i.e. ilvl=0
// is a real CSI PART heading. Start-anchored, requiring the %-field plus a trailing
// boundary (delimiter, whitespace, or end), so it matches the real label templates —
// e.g. "PART  %1  ", "PART %1 -", "PART %1" — while rejecting incidental
// matches ("PART OF %1" / "%1 PART" / "PART-%1") AND embedded prefixes
// ("SECTION PART %1"), none of which a CSI part level emits. The "^" matters: an
// un-anchored \bPART\s*%\d would accept "SECTION PART %1" and falsely mark that numId
// spec-shaped, so inference.ts would then promote unrelated ilvl=0 paragraphs to PART.
const PART_LVLTEXT_PATTERN = /^PART\s+%\d(?:\s*[-–—.:]\s*|\s|$)/i;

// Some documents link no pStyles to their numbering (the PART paragraphs use plain
// text styles), so the pStyle-ladder rule misses them. But their ilvl=0 lvlText
// literally generates a "PART n" prefix — direct, low-false-positive evidence
// ilvl=0 is a PART. Generic <ol> lists use "%1."/"•"/"(%1)" lvlText, never "PART".
function ilvlZeroDeclaresPart(an: AbstractNum): boolean {
  const lvl0 = an.levels.find((lvl) => lvl.ilvl === 0);
  return lvl0?.lvlText !== undefined && PART_LVLTEXT_PATTERN.test(lvl0.lvlText);
}

// A numbering definition whose levels link a multi-level style ladder is
// spec-shaped: flat lists (LibreOffice <ol>) link zero styles, single-purpose
// numbering links one. Three or more linked levels means part/article/pr
// tiers — strong evidence ilvl=0 under this numId is a real PART heading. The
// non-pStyle-linked case is caught instead by its ilvl=0 "PART" lvlText.
function findSpecShapedNumIds(
  nums: ReadonlyMap<number, Num>,
  abstractNums: ReadonlyMap<number, AbstractNum>
): ReadonlySet<number> {
  const specShaped = new Set<number>();
  for (const num of nums.values()) {
    const an = abstractNums.get(num.abstractNumId);
    if (!an) continue;
    const linkedLevels = an.levels.filter((lvl) => lvl.pStyle).length;
    if (linkedLevels >= SPEC_SHAPED_MIN_LINKED_LEVELS || ilvlZeroDeclaresPart(an)) {
      specShaped.add(num.numId);
    }
  }
  return specShaped;
}

// Detect articleIlvl from numbering.xml: some documents reserve ilvl 1-2 for a
// Schedule / Product-Data block and mark those levels with those keywords in
// lvlText. Secondary signal; the orchestrator prefers StyleMap detection when available.
function detectArticleIlvl(abstractNums: ReadonlyMap<number, AbstractNum>): number {
  for (const an of abstractNums.values()) {
    for (const lvl of an.levels) {
      if (lvl.ilvl !== 1 && lvl.ilvl !== 2) continue;
      const upper = (lvl.lvlText ?? '').toUpperCase();
      if (upper.includes('SCHEDULE') || upper.includes('PRODUCT DATA')) return 3;
    }
  }
  return 1;
}

export function buildNumberingMap(xml: string): NumberingMap {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch (err) {
    throw new ParserError('failed to parse numbering.xml', {
      code: 'NUMBERING_XML_INVALID',
      cause: err,
    });
  }
  const root = (parsed as Record<string, unknown>)['w:numbering'] as
    Record<string, unknown> | undefined;
  if (!root) return emptyNumberingMap();

  const abstractNums = parseAbstractNums(
    toArray(root['w:abstractNum'] as readonly unknown[] | undefined)
  );
  const nums = parseNums(toArray(root['w:num'] as readonly unknown[] | undefined));
  const { pStyleToNumId, pStyleToIlvl } = buildPStyleMaps(nums, abstractNums);
  const articleIlvl = detectArticleIlvl(abstractNums);
  const specShapedNumIds = findSpecShapedNumIds(nums, abstractNums);
  return { nums, abstractNums, pStyleToNumId, pStyleToIlvl, articleIlvl, specShapedNumIds };
}

/** Return a new NumberingMap with articleIlvl overridden. Used by orchestrator after StyleMap detection. */
export function withArticleIlvl(map: NumberingMap, articleIlvl: number): NumberingMap {
  return { ...map, articleIlvl };
}

export function emptyNumberingMap(): NumberingMap {
  return {
    nums: new Map(),
    abstractNums: new Map(),
    pStyleToNumId: new Map(),
    pStyleToIlvl: new Map(),
    articleIlvl: 1,
    specShapedNumIds: new Set(),
  };
}
