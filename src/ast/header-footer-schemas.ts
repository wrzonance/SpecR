import { z } from 'zod';

// JSONB-backed header/footer composition follows ADR-021: known keys are typed,
// unknown JSON-safe keys are preserved for client/project-specific extensions.
const JsonValue = z.json();

export const HeaderFooterFieldKindSchema = z.enum([
  'date',
  'sectionTitle',
  'sectionNumber',
  'pageNumber',
  'packageName',
  'revisionName',
  'revisionLabel',
  'projectName',
  'projectNumber',
  'clientName',
  'clientNumber',
  'literal',
]);

const HeaderFooterFieldSchema = z
  .object({
    kind: HeaderFooterFieldKindSchema,
    source: z.enum(['issuance', 'current']).exactOptional(),
    text: z.string().exactOptional(),
    label: z.string().exactOptional(),
    format: z.string().exactOptional(),
    prefix: z.string().exactOptional(),
    suffix: z.string().exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterVisualStyleSchema = z
  .object({
    fontFamily: z.string().exactOptional(),
    fontSizeHalfPt: z.number().int().exactOptional(),
    bold: z.boolean().exactOptional(),
    italic: z.boolean().exactOptional(),
    caps: z.boolean().exactOptional(),
    color: z.string().exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterRuleLineSchema = z
  .object({
    enabled: z.boolean().exactOptional(),
    widthTwips: z.number().int().exactOptional(),
    color: z.string().exactOptional(),
    style: z.string().exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterCellSchema = z
  .object({
    content: z.array(HeaderFooterFieldSchema).exactOptional(),
    separator: z.string().exactOptional(),
    style: HeaderFooterVisualStyleSchema.exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterRegionSchema = z
  .object({
    left: HeaderFooterCellSchema.exactOptional(),
    center: HeaderFooterCellSchema.exactOptional(),
    right: HeaderFooterCellSchema.exactOptional(),
    style: HeaderFooterVisualStyleSchema.exactOptional(),
    ruleLine: HeaderFooterRuleLineSchema.exactOptional(),
  })
  .catchall(JsonValue);

export const HeaderFooterCompositionSchema = z
  .object({
    header: HeaderFooterRegionSchema.exactOptional(),
    footer: HeaderFooterRegionSchema.exactOptional(),
    style: HeaderFooterVisualStyleSchema.exactOptional(),
  })
  .catchall(JsonValue);

export type HeaderFooterFieldKind = z.infer<typeof HeaderFooterFieldKindSchema>;
export type HeaderFooterComposition = z.infer<typeof HeaderFooterCompositionSchema>;
