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
// structural floor, so historical rows load cleanly while writes stay strict at
// ingress. It is NOT a rubber stamp: field presence, JS types, and the closed tier
// vocabulary are still enforced, so a genuinely-corrupt row still throws. See ADR-060.
//
// Maintenance rule: a future write-side tightening that is a numeric bound is already
// covered here (read drops all bounds). A tightening of a *different* kind — narrowing
// a literal/enum, or adding a required field — must be mirrored as a relaxation here,
// or it reintroduces the read-500 risk. The read-tolerance tests are the guardrail.

const PartTierReadSchema = z
  .object({ numberStyle: z.literal('integer'), maxCount: z.number().int() })
  .catchall(JsonValue);

const TierShapeReadSchema = z
  .object({ maxCount: z.number().int().exactOptional() })
  .catchall(JsonValue);

const NumberingLevelReadSchema = z
  .object({
    ilvl: z.number().int(),
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
    ilvl: z.number().int(),
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
    articleIlvl: z.number().int().exactOptional(),
  })
  .catchall(JsonValue);

// Write and read schemas differ only in refinements (min/max/positive), which do not
// affect z.infer — so both yield the identical runtime shape. NumberingProfile is the
// canonical type for a valid profile; a read parse produces an assignable value.
export type TierName = z.infer<typeof TierNameSchema>;
export type NumberingProfile = z.infer<typeof NumberingProfileSchema>;
