// Pure snapshot extractor: NumberingMap + StyleMap → NumberingProfile, plus the
// inverse (applyNumberingProfile) and the profile-vs-inference conflict merge.
// No I/O, no mutation of inputs.

import type { ClassifiedParagraph, NumberingMap, SignalConflict, StyleMap } from './types.js';
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

  // Primary source: pStyleToNumId + pStyleToIlvl (both must be present for a style
  // to qualify). Skip non-spec-shaped numIds so a generic bullet/flat-list style at
  // ilvl=0 is not serialized as a structural tier (buildNumbering already excludes
  // them; applyNumberingProfile would otherwise replay a bogus 'part' override).
  for (const [styleId, numId] of map.pStyleToNumId) {
    if (!map.specShapedNumIds.has(numId)) continue;
    const ilvl = map.pStyleToIlvl.get(styleId);
    if (ilvl === undefined) continue;
    ladder.set(styleId, { styleId, numId, ilvl, tier: tierForIlvl(ilvl, map.articleIlvl) });
  }

  // Union: resolvedNumPr provides the authoritative effective-numPr per style
  // after walking the basedOn chain — add any style not already populated above
  for (const [styleId, numPr] of styles.resolvedNumPr) {
    if (!map.specShapedNumIds.has(numPr.numId)) continue;
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

// ─── Apply (inverse of extract) ─────────────────────────────────────────────────

function pStyleMapsFromLadder(ladder: NumberingProfile['styleLadder']): {
  pStyleToNumId: ReadonlyMap<string, number>;
  pStyleToIlvl: ReadonlyMap<string, number>;
} {
  const pStyleToNumId = new Map<string, number>();
  const pStyleToIlvl = new Map<string, number>();
  for (const entry of ladder) {
    pStyleToNumId.set(entry.styleId, entry.numId);
    pStyleToIlvl.set(entry.styleId, entry.ilvl);
  }
  return { pStyleToNumId, pStyleToIlvl };
}

/**
 * Apply a numbering profile as a deterministic override of a base NumberingMap.
 * Returns a NEW map (never mutates `base`). A field is overridden ONLY when the
 * profile actually specifies it: an empty `numbering`/`styleLadder` and an absent
 * `articleIlvl` mean "keep base", so the built-in empty 'CSI Default' is a
 * byte-for-byte passthrough. `nums`/`abstractNums` are always kept from base —
 * the profile does not carry enough to rebuild them and classification never
 * needs them. The inverse of extractNumberingProfile (round-trip on the four
 * classification fields: articleIlvl, specShapedNumIds, pStyleToNumId, pStyleToIlvl).
 */
export function applyNumberingProfile(base: NumberingMap, profile: NumberingProfile): NumberingMap {
  const { pStyleToNumId, pStyleToIlvl } =
    profile.styleLadder.length > 0
      ? pStyleMapsFromLadder(profile.styleLadder)
      : { pStyleToNumId: base.pStyleToNumId, pStyleToIlvl: base.pStyleToIlvl };
  return {
    nums: base.nums,
    abstractNums: base.abstractNums,
    pStyleToNumId,
    pStyleToIlvl,
    articleIlvl: profile.articleIlvl !== undefined ? profile.articleIlvl : base.articleIlvl,
    specShapedNumIds:
      profile.numbering.length > 0
        ? new Set(profile.numbering.map((n) => n.numId))
        : base.specShapedNumIds,
  };
}

// ─── Profile-vs-inference conflict merge ─────────────────────────────────────────

function differs(a: ClassifiedParagraph, b: ClassifiedParagraph): boolean {
  return a.nodeType !== b.nodeType || a.resolvedIlvl !== b.resolvedIlvl;
}

/**
 * Record profile-vs-inference disagreements without dropping the losing result.
 * `withProfile` (authoritative, profile-driven) and `base` (un-profiled) classify
 * the SAME paragraphs index-aligned. Where they differ, return a new
 * ClassifiedParagraph equal to `withProfile[i]` with the base (losing) result
 * appended to `.conflicts` as a SignalConflict — surfaced via the existing
 * `meta.conflicts` channel (no AST schema change). Agreeing paragraphs are
 * returned unchanged (same reference). Immutable — never mutates inputs.
 */
export function mergeProfileConflicts(
  withProfile: readonly ClassifiedParagraph[],
  base: readonly ClassifiedParagraph[]
): ClassifiedParagraph[] {
  return withProfile.map((cp, i) => {
    const losing = base[i];
    if (losing === undefined || !differs(cp, losing)) return cp;
    const conflict: SignalConflict = {
      signal: losing.signalUsed,
      reportedIlvl: losing.resolvedIlvl,
      reportedNodeType: losing.nodeType,
    };
    return { ...cp, conflicts: [...cp.conflicts, conflict] };
  });
}
