import { z } from 'zod';

const JsonValue = z.json();

export const TierNameSchema = z.enum(['part', 'article', 'paragraph', 'subparagraph']);

const TierShapeSchema = z
  .object({ maxCount: z.number().int().positive().exactOptional() })
  .catchall(JsonValue);

// The PART tier is pinned to the CSI integer model: integer style, ≤5 parts.
const PartTierSchema = z
  .object({ numberStyle: z.literal('integer'), maxCount: z.number().int().min(1).max(5) })
  .catchall(JsonValue);

const NumberingLevelSchema = z
  .object({
    ilvl: z.number().int().min(0),
    tier: TierNameSchema,
    labelTemplate: z.string().exactOptional(),
    numFmt: z.string().exactOptional(),
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
    numbering: z.array(
      z
        .object({ numId: z.number().int(), levels: z.array(NumberingLevelSchema) })
        .catchall(JsonValue)
    ),
    styleLadder: z.array(
      z
        .object({
          styleId: z.string(),
          numId: z.number().int(),
          ilvl: z.number().int().min(0),
          tier: TierNameSchema,
        })
        .catchall(JsonValue)
    ),
    // Article sits BELOW part; ilvl 0 is always 'part' (ilvlToNodeType), so the
    // Article level is never 0. min(1) rejects an unrepresentable articleIlvl 0. (#320)
    articleIlvl: z.number().int().min(1).exactOptional(),
  })
  .catchall(JsonValue);

export type TierName = z.infer<typeof TierNameSchema>;
export type NumberingProfile = z.infer<typeof NumberingProfileSchema>;
