import { z } from 'zod';

const JsonValue = z.json();

export const TierNameSchema = z.enum(['part', 'article', 'paragraph', 'subparagraph']);
export type TierName = z.infer<typeof TierNameSchema>;

// ── Tier derivation (#319) ───────────────────────────────────────────────────
// tier is DERIVED from (ilvl, articleIlvl), not authoritative client input — see
// ADR-067. Banding: everything above articleIlvl is 'part', articleIlvl itself is
// 'article', one below is 'paragraph', everything else is 'subparagraph'.
export function tierForIlvl(ilvl: number, articleIlvl: number): TierName {
  if (ilvl < articleIlvl) return 'part';
  if (ilvl === articleIlvl) return 'article';
  if (ilvl === articleIlvl + 1) return 'paragraph';
  return 'subparagraph';
}

// ── Strict WRITE contract ────────────────────────────────────────────────────
// "What we accept from clients." The CSI integer-PART model with its full policy
// bounds; used at every write ingress (create/update, API request bodies).

// The PART tier is pinned to the CSI integer model: integer style, ≤5 parts.
const PartTierSchema = z
  .object({ numberStyle: z.literal('integer'), maxCount: z.number().int().min(1).max(5) })
  .catchall(JsonValue);

const TierShapeSchema = z
  .object({ maxCount: z.number().int().positive().exactOptional() })
  .catchall(JsonValue);

// tier is exactOptional on write: server derives it from (ilvl, articleIlvl) when
// omitted, and rejects it outright when supplied but inconsistent with the
// derivation (#319, ADR-067) — see checkTierEntriesMatchDerived below.
//
// Each catchall'd write schema below is built as `<Name>Shape` (no catchall,
// used ONLY for typing) then `<Name>Schema = <Name>Shape.catchall(JsonValue)`
// (used for parsing). Reason: TypeScript's Omit/Pick collapse ALL named
// properties of a type to its index signature's value type once keyof that
// type is widened to `string` by an index signature (a known homomorphic-
// mapped-type limitation, verified by direct repro) — so the Output types
// below must Omit from the plain Shape, never from a catchall'd type.
const NumberingLevelShape = z.object({
  ilvl: z.number().int().min(0),
  tier: TierNameSchema.exactOptional(),
  labelTemplate: z.string().exactOptional(),
  numFmt: z.string().exactOptional(),
});
const NumberingLevelSchema = NumberingLevelShape.catchall(JsonValue);

const NumberingGroupShape = z.object({
  numId: z.number().int(),
  levels: z.array(NumberingLevelSchema),
});
const NumberingGroupSchema = NumberingGroupShape.catchall(JsonValue);

const StyleLadderEntryShape = z.object({
  styleId: z.string(),
  numId: z.number().int(),
  ilvl: z.number().int().min(0),
  tier: TierNameSchema.exactOptional(),
});
const StyleLadderEntrySchema = StyleLadderEntryShape.catchall(JsonValue);

// Named intermediate schema: the .check() validators below need a concrete
// schema type to reference before NumberingProfileSchema (which chains onto
// them) exists.
const NumberingProfileShape = z.object({
  tiers: z
    .object({
      part: PartTierSchema,
      article: TierShapeSchema.exactOptional(),
      paragraph: TierShapeSchema.exactOptional(),
      subparagraph: TierShapeSchema.exactOptional(),
    })
    .catchall(JsonValue),
  numbering: z.array(NumberingGroupSchema),
  styleLadder: z.array(StyleLadderEntrySchema),
  // Article sits BELOW part; ilvl 0 is always 'part' (ilvlToNodeType), so the
  // Article level is never 0. min(1) rejects an unrepresentable articleIlvl 0. (#320)
  articleIlvl: z.number().int().min(1).exactOptional(),
});
const NumberingProfileObjectSchema = NumberingProfileShape.catchall(JsonValue);

type NumberingProfileInput = z.infer<typeof NumberingProfileObjectSchema>;
type NumberingGroupInput = z.infer<typeof NumberingGroupSchema>;
type StyleLadderEntryInput = z.infer<typeof StyleLadderEntrySchema>;
type JsonValueType = z.infer<typeof JsonValue>;

// Output types: tier is always present and consistent after a successful parse
// (ADR-067) — never left as `tier?: TierName`, so a future caller dereferencing
// `.tier` gets a real guarantee instead of a latent optional-chaining trap.
// Every other field keeps its original optionality (Omit from the Shape types
// above preserves modifiers correctly, unlike Omit from a catchall'd type).
type NumberingLevelOutput = Omit<z.infer<typeof NumberingLevelShape>, 'tier'> & {
  tier: TierName;
} & Record<string, JsonValueType>;

type NumberingGroupOutput = Omit<z.infer<typeof NumberingGroupShape>, 'levels'> & {
  levels: NumberingLevelOutput[];
} & Record<string, JsonValueType>;

type StyleLadderEntryOutput = Omit<z.infer<typeof StyleLadderEntryShape>, 'tier'> & {
  tier: TierName;
} & Record<string, JsonValueType>;

// The canonical type for a valid, transformed profile. Declared explicitly
// (never as z.infer<typeof NumberingProfileSchema>) for two reasons: (1) that
// would be circular — NumberingProfileSchema's own .transform<NumberingProfile>()
// needs this type before the schema exists — and (2) an inferred type would
// downgrade `tier` back to optional, contradicting the "tier is always present"
// guarantee above. See ADR-067. Built the same Shape-Omit way as the nested
// Output types above, for the same Omit-collapse reason.
export type NumberingProfile = Omit<
  z.infer<typeof NumberingProfileShape>,
  'numbering' | 'styleLadder'
> & {
  numbering: NumberingGroupOutput[];
  styleLadder: StyleLadderEntryOutput[];
} & Record<string, JsonValueType>;

function pushCustomIssue(ctx: z.core.ParsePayload<NumberingProfileInput>, message: string): void {
  ctx.issues.push({ code: 'custom', input: ctx.value, message });
}

// articleIlvl is the only thing tierForIlvl needs; require it as soon as there is
// anything to derive a tier for (#319).
function checkArticleIlvlRequired(ctx: z.core.ParsePayload<NumberingProfileInput>): void {
  const { articleIlvl, numbering, styleLadder } = ctx.value;
  if (articleIlvl === undefined && (numbering.length > 0 || styleLadder.length > 0)) {
    pushCustomIssue(ctx, 'articleIlvl is required when numbering or styleLadder is non-empty');
  }
}

function checkNumberingTierEntries(
  ctx: z.core.ParsePayload<NumberingProfileInput>,
  numbering: readonly NumberingGroupInput[],
  articleIlvl: number
): void {
  for (const group of numbering) {
    for (const level of group.levels) {
      if (level.tier === undefined) continue;
      const derived = tierForIlvl(level.ilvl, articleIlvl);
      if (level.tier !== derived) {
        pushCustomIssue(
          ctx,
          `numbering[numId=${group.numId}] level ilvl=${level.ilvl} declares tier '${level.tier}' but derives to '${derived}'`
        );
      }
    }
  }
}

function checkStyleLadderTierEntries(
  ctx: z.core.ParsePayload<NumberingProfileInput>,
  styleLadder: readonly StyleLadderEntryInput[],
  articleIlvl: number
): void {
  for (const entry of styleLadder) {
    if (entry.tier === undefined) continue;
    const derived = tierForIlvl(entry.ilvl, articleIlvl);
    if (entry.tier !== derived) {
      pushCustomIssue(
        ctx,
        `styleLadder[styleId=${entry.styleId}] ilvl=${entry.ilvl} declares tier '${entry.tier}' but derives to '${derived}'`
      );
    }
  }
}

// No-op when articleIlvl is absent: checkArticleIlvlRequired already reported it
// (or numbering/styleLadder are both empty, so there is nothing to check).
function checkTierEntriesMatchDerived(ctx: z.core.ParsePayload<NumberingProfileInput>): void {
  const { articleIlvl, numbering, styleLadder } = ctx.value;
  if (articleIlvl === undefined) return;
  checkNumberingTierEntries(ctx, numbering, articleIlvl);
  checkStyleLadderTierEntries(ctx, styleLadder, articleIlvl);
}

// Reachable only after both checks above passed: articleIlvl === undefined here
// implies numbering and styleLadder are both empty (checkArticleIlvlRequired
// would otherwise have raised an issue, and .transform() never runs when a
// preceding .check() reports one), so the empty-array return still satisfies
// NumberingProfile's Output types.
function fillDerivedTiers(profile: NumberingProfileInput): NumberingProfile {
  if (profile.articleIlvl === undefined) {
    return { ...profile, numbering: [], styleLadder: [] };
  }
  const articleIlvl = profile.articleIlvl;
  return {
    ...profile,
    numbering: profile.numbering.map((group) => ({
      ...group,
      levels: group.levels.map((level) => ({
        ...level,
        tier: level.tier ?? tierForIlvl(level.ilvl, articleIlvl),
      })),
    })),
    styleLadder: profile.styleLadder.map((entry) => ({
      ...entry,
      tier: entry.tier ?? tierForIlvl(entry.ilvl, articleIlvl),
    })),
  };
}

export const NumberingProfileSchema = NumberingProfileObjectSchema.check(checkArticleIlvlRequired)
  .check(checkTierEntriesMatchDerived)
  .transform<NumberingProfile>(fillDerivedTiers);

// ── Lenient READ contract (#323) ─────────────────────────────────────────────
// "What we can read back from storage." Reads re-validate the persisted JSONB, so
// any *tightening* of the write schema (e.g. articleIlvl min(0)→min(1), #322) could
// retroactively turn a previously-valid row into a 500 on read. The read schema is
// the same SHAPE as the write schema with the numeric POLICY bounds relaxed to their
// STRUCTURAL FLOOR, so historical rows load cleanly while writes stay strict at
// ingress. It is NOT a rubber stamp: field presence, JS types, the closed tier
// vocabulary, AND the structural floor of each numeric field are still enforced, so a
// genuinely-corrupt row still throws. See ADR-061.
//
// "Relax to the structural floor" is deliberate, not "drop all bounds": an `ilvl` is a
// 0-based level index and a `maxCount` is a tier size, so `ilvl >= 0` / `count >= 1`
// are not policy — they are the meaning of the field. A negative `articleIlvl` was
// never valid under any historical contract; admitting it would let a corrupt row flow
// into the parser, where `ilvlToNodeType` uses articleIlvl as a subtraction offset and
// would silently shift every tier instead of surfacing the corruption (#323, Codex).
// So the read schema keeps the floors and drops only the POLICY bounds that a tightening
// could newly impose: `part.maxCount`'s CSI ceiling of 5, and `articleIlvl`'s min(1)
// (relaxed to its structural floor min(0), which is the legacy #320 case).
//
// Maintenance rule: a future write-side tightening that RAISES a policy floor above the
// structural minimum, LOWERS a ceiling, narrows a literal/enum, or adds a required field
// must be mirrored as a relaxation here (down to the structural floor, no further), or it
// reintroduces the read-500 risk. The read-tolerance tests are the guardrail.

const PartTierReadSchema = z
  // drop only the CSI policy ceiling max(5); keep the structural floor min(1)
  .object({ numberStyle: z.literal('integer'), maxCount: z.number().int().min(1) })
  .catchall(JsonValue);

const TierShapeReadSchema = z
  // maxCount is a tier size — positive is structural, not policy; keep it
  .object({ maxCount: z.number().int().positive().exactOptional() })
  .catchall(JsonValue);

const NumberingLevelReadSchema = z
  .object({
    ilvl: z.number().int().min(0), // structural floor: an ilvl is a 0-based level index
    tier: TierNameSchema,
    labelTemplate: z.string().exactOptional(),
    numFmt: z.string().exactOptional(),
  })
  .catchall(JsonValue);

const NumberingGroupReadSchema = z
  .object({ numId: z.number().int(), levels: z.array(NumberingLevelReadSchema) })
  .catchall(JsonValue);

const StyleLadderEntryReadSchema = z
  .object({
    styleId: z.string(),
    numId: z.number().int(),
    ilvl: z.number().int().min(0), // structural floor: an ilvl is a 0-based level index
    tier: TierNameSchema,
  })
  .catchall(JsonValue);

export const NumberingProfileReadSchema = z
  .object({
    tiers: z
      .object({
        part: PartTierReadSchema,
        article: TierShapeReadSchema.exactOptional(),
        paragraph: TierShapeReadSchema.exactOptional(),
        subparagraph: TierShapeReadSchema.exactOptional(),
      })
      .catchall(JsonValue),
    numbering: z.array(NumberingGroupReadSchema),
    styleLadder: z.array(StyleLadderEntryReadSchema),
    // structural floor min(0) (legacy #320 case), not the write-side policy min(1)
    articleIlvl: z.number().int().min(0).exactOptional(),
  })
  .catchall(JsonValue);

// The read schema requires `tier` on every entry (no derivation on read — a
// persisted row was already validated as consistent on write, #319) and keeps
// numeric bounds relaxed to their structural floor (#323, above). Its inferred
// shape is structurally assignable to NumberingProfile.
