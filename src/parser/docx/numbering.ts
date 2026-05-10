import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { getAttrVal, getAttrNumVal, extractAttrStr, toArray } from './xml-utils.js';
import type { AbstractNum, AbstractNumLevel, Num, NumberingMap, NumLvlOverride } from './types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
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

// MASTERSPEC reserves ilvl 1-2 for Schedule/PDS; Article starts at ilvl 3.
// Detect by checking lvlText of ilvl 1 or 2 for those keywords.
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
    throw new ParserError('failed to parse numbering.xml', { cause: err });
  }
  const root = (parsed as Record<string, unknown>)['w:numbering'] as
    | Record<string, unknown>
    | undefined;
  if (!root) return emptyNumberingMap();

  const abstractNums = parseAbstractNums(
    toArray(root['w:abstractNum'] as readonly unknown[] | undefined)
  );
  const nums = parseNums(toArray(root['w:num'] as readonly unknown[] | undefined));
  const { pStyleToNumId, pStyleToIlvl } = buildPStyleMaps(nums, abstractNums);
  const articleIlvl = detectArticleIlvl(abstractNums);
  return { nums, abstractNums, pStyleToNumId, pStyleToIlvl, articleIlvl };
}

export function emptyNumberingMap(): NumberingMap {
  return {
    nums: new Map(),
    abstractNums: new Map(),
    pStyleToNumId: new Map(),
    pStyleToIlvl: new Map(),
    articleIlvl: 1,
  };
}
