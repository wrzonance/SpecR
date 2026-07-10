import { z } from 'zod';

const JsonValue = z.json();

export const TierNameSchema = z.enum(['part', 'article', 'paragraph', 'subparagraph']);

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

const NumberingLevelSchema = z
  .object({
    ilvl: z.number().int().min(0),
    tier: TierNameSchema,
    labelTemplate: z.string().exactOptional(),
    numFmt: z.string().exactOptional(),
  })
  .catchall(JsonValue);

const NumberingGroupSchema = z
  .object({ numId: z.number().int(), levels: z.array(NumberingLevelSchema) })
  .catchall(JsonValue);

const StyleLadderEntrySchema = z
  .object({
    styleId: z.string(),
    numId: z.number().int(),
    ilvl: z.number().int().min(0),
    tier: TierNameSchema,
  })
  .catchall(JsonValue);

export const NumberingProfileSchema = z
  .object({
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
  })
  .catchall(JsonValue);

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

// Write and read schemas differ only in refinements (min/max/positive), which do not
// affect z.infer — so both yield the identical runtime shape. NumberingProfile is the
// canonical type for a valid profile; a read parse produces an assignable value.
export type TierName = z.infer<typeof TierNameSchema>;
export type NumberingProfile = z.infer<typeof NumberingProfileSchema>;
