// Pure snapshot extractor: NumberingMap + StyleMap → NumberingProfile.
// No I/O, no mutation of inputs. Task 5 (applyNumberingProfile) is the inverse.

import type { NumberingMap, StyleMap } from './types.js';
import type { NumberingProfile, TierName } from '../../ast/index.js';

// ─── Tier assignment ──────────────────────────────────────────────────────────

function tierForIlvl(ilvl: number, articleIlvl: number): TierName {
  if (ilvl < articleIlvl) return 'part';
  if (ilvl === articleIlvl) return 'article';
  if (ilvl === articleIlvl + 1) return 'paragraph';
  return 'subparagraph';
}

// ─── Numbering entries ────────────────────────────────────────────────────────

function buildNumbering(map: NumberingMap): NumberingProfile['numbering'] {
  const result: NumberingProfile['numbering'] = [];
  for (const [numId, num] of map.nums) {
    // Only spec-shaped numIds describe the structural ladder. A generic list
    // numId would get tier 'part' at ilvl 0 (0 < articleIlvl) — wrong, and it
    // would make every numId look spec-shaped. Skipping non-spec-shaped numIds
    // lets Task 5 reconstruct specShapedNumIds as exactly the set of emitted numIds.
    if (!map.specShapedNumIds.has(numId)) continue;
    const absNum = map.abstractNums.get(num.abstractNumId);
    // Skip numIds whose abstractNum is missing — see test: KNOWN AMBIGUITY
    if (absNum === undefined) continue;
    const levels = absNum.levels.map((l) => ({
      ilvl: l.ilvl,
      tier: tierForIlvl(l.ilvl, map.articleIlvl),
      numFmt: l.numFmt, // AbstractNumLevel.numFmt is always present
      ...(l.lvlText !== undefined ? { labelTemplate: l.lvlText } : {}),
    }));
    result.push({ numId, levels });
  }
  return result;
}

// ─── Style ladder ─────────────────────────────────────────────────────────────

type LadderEntry = { styleId: string; numId: number; ilvl: number; tier: TierName };

function buildStyleLadder(map: NumberingMap, styles: StyleMap): NumberingProfile['styleLadder'] {
  const ladder = new Map<string, LadderEntry>();

  // Primary source: pStyleToNumId + pStyleToIlvl (both must be present for a style to qualify)
  for (const [styleId, numId] of map.pStyleToNumId) {
    const ilvl = map.pStyleToIlvl.get(styleId);
    if (ilvl === undefined) continue;
    ladder.set(styleId, { styleId, numId, ilvl, tier: tierForIlvl(ilvl, map.articleIlvl) });
  }

  // Union: resolvedNumPr provides the authoritative effective-numPr per style
  // after walking the basedOn chain — add any style not already populated above
  for (const [styleId, numPr] of styles.resolvedNumPr) {
    if (ladder.has(styleId)) continue;
    ladder.set(styleId, {
      styleId,
      numId: numPr.numId,
      ilvl: numPr.ilvl,
      tier: tierForIlvl(numPr.ilvl, map.articleIlvl),
    });
  }

  return [...ladder.values()].sort((a, b) => a.styleId.localeCompare(b.styleId));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractNumberingProfile(map: NumberingMap, styles: StyleMap): NumberingProfile {
  return {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: buildNumbering(map),
    styleLadder: buildStyleLadder(map, styles),
    articleIlvl: map.articleIlvl,
  };
}
