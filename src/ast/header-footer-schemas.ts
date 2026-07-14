import { z } from 'zod';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import { HEADER_FOOTER_JSON_BODY_LIMIT_BYTES } from '../lib/header-footer-body-limit.js';

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
  'image',
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
    // `kind: 'image'` fields (#308, ADR-069). `imageData` is base64; the size cap
    // is enforced here (encoded-length-first, matching decodeBase64Payload's
    // posture) so an oversized payload is rejected before any buffer is
    // materialized. `imageMediaType` is deliberately OPEN (mirrors
    // `ruleLine.style`) — the generator never trusts it and re-sniffs the actual
    // bytes (src/lib/image-media-type.ts); an unsupported/stale value here still
    // round-trips, it just won't render.
    imageData: z
      .string()
      .max(MAX_IMAGE_BASE64_LENGTH, {
        error: `imageData exceeds the ${MAX_IMAGE_BASE64_LENGTH}-char base64 size cap`,
      })
      .exactOptional(),
    imageMediaType: z.string().exactOptional(),
    widthEmu: z.number().int().positive().exactOptional(),
    heightEmu: z.number().int().positive().exactOptional(),
    altText: z.string().exactOptional(),
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

// A single header/footer page variant — the v1 `{ header, footer, style }`
// shape (#208). Reused for each Word-style page variant (default/first/even).
const variantShape = {
  header: HeaderFooterRegionSchema.exactOptional(),
  footer: HeaderFooterRegionSchema.exactOptional(),
  style: HeaderFooterVisualStyleSchema.exactOptional(),
};

export const HeaderFooterVariantSchema = z.object(variantShape).catchall(JsonValue);

// Word-style page variants (ADR-040): `default` applies to every page unless a
// more specific variant overrides it; `first` overrides the first page
// (`w:titlePg`); `even` overrides even pages (`w:evenAndOddHeaders`).
const HeaderFooterVariantsSchema = z
  .object({
    default: HeaderFooterVariantSchema.exactOptional(),
    first: HeaderFooterVariantSchema.exactOptional(),
    even: HeaderFooterVariantSchema.exactOptional(),
  })
  .catchall(JsonValue);

export const PageNumberingModeSchema = z.enum(['continuous', 'restartPerSpec']);

// Page-numbering policy: continuous across the package, or restarting at each
// spec section. `startAt` seeds the first rendered number (`w:pgNumType@start`).
const PageNumberingSchema = z
  .object({
    mode: PageNumberingModeSchema,
    startAt: z.number().int().exactOptional(),
  })
  .catchall(JsonValue);

// A single captured-but-unmodeled header/footer content item (#306, ADR-068):
// content the capture recognized but could not map into a typed field —
// preserved here (JSON-safe, already parsed — never re-serialized OOXML) so
// acceptance criterion 3 ("preserved") is met, alongside a matching
// `raw.warnings` entry for criterion 4 ("warned, never silently dropped).
// `inactiveVariant` is distinct from `unresolvedReference`: the former's
// reference DID resolve to a real relationship target, but the section's own
// page-variant toggle (`w:titlePg`/`w:evenAndOddHeaders`) is off, so Word
// itself would not render it — promoting it into `variants.first`/`.even`
// would fabricate behavior the source document doesn't exhibit.
export const HeaderFooterUnmodeledEntrySchema = z.object({
  variant: z.enum(['default', 'first', 'even']),
  region: z.enum(['header', 'footer']),
  kind: z.enum([
    'image',
    'table',
    'unrecognizedField',
    'unresolvedReference',
    'extraParagraph',
    'inactiveVariant',
  ]),
  detail: JsonValue,
});

// Open sidecar for captured but unmodeled header/footer OOXML plus parser
// warnings (#306). Fully open so round-tripping never loses unsupported markup.
const HeaderFooterRawSidecarSchema = z
  .object({
    warnings: z.array(z.string()).exactOptional(),
    unmodeled: z.array(HeaderFooterUnmodeledEntrySchema).exactOptional(),
  })
  .catchall(JsonValue);

/**
 * Approximate serialized byte size of a parsed composition — the same
 * encoded-length-first, pre-materialization posture `MAX_IMAGE_BASE64_LENGTH`
 * and `decodeBase64Payload` already use elsewhere in this schema: cheap and
 * close enough to guard an invariant, not a byte-exact wire measurement (key
 * order/number formatting can differ from what the client actually sent).
 * Pure and total — `JSON.stringify` never throws on a Zod-parsed, JSON-safe
 * value (every leaf is `z.json()` or a JSON-primitive-typed field).
 */
function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export const HeaderFooterCompositionSchema = z
  .object({
    // v1 (#208) fields — preserved; read as the `default` variant (ADR-040).
    ...variantShape,
    // v2 (#302) fields.
    variants: HeaderFooterVariantsSchema.exactOptional(),
    pageNumbering: PageNumberingSchema.exactOptional(),
    raw: HeaderFooterRawSidecarSchema.exactOptional(),
  })
  .catchall(JsonValue)
  // Code-review finding (#490 follow-up): every level above is
  // `.catchall(JsonValue)` (ADR-021 open extensions) with no size bound of
  // its own, so a structurally-valid composition could still carry unbounded
  // open-extension data and exceed `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES` —
  // the transport limit `src/api/header-footer-body-limit.ts` derives for
  // exactly the one-image case this schema advertises (ADR-070). Enforcing
  // the SAME budget here, once, at the top level (rather than duplicating a
  // per-field cap into every nested catchall) keeps "Zod-valid" and "fits
  // the transport limit" from ever diverging — the multi-image accepted
  // limitation ADR-070 documents remains the only gap.
  .check((ctx) => {
    const byteLength = serializedByteLength(ctx.value);
    if (byteLength <= HEADER_FOOTER_JSON_BODY_LIMIT_BYTES) return;
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message:
        `composition serializes to ~${byteLength} bytes, exceeding the ` +
        `${HEADER_FOOTER_JSON_BODY_LIMIT_BYTES}-byte transport limit ` +
        '(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES) — open .catchall extension ' +
        'keys (ADR-021) share the same byte budget as imageData, not an ' +
        'unbounded one',
    });
  });

export type HeaderFooterFieldKind = z.infer<typeof HeaderFooterFieldKindSchema>;
export type HeaderFooterVariant = z.infer<typeof HeaderFooterVariantSchema>;
export type PageNumberingMode = z.infer<typeof PageNumberingModeSchema>;
export type HeaderFooterUnmodeledEntry = z.infer<typeof HeaderFooterUnmodeledEntrySchema>;
export type HeaderFooterComposition = z.infer<typeof HeaderFooterCompositionSchema>;

/**
 * The effective `default` page variant for a composition.
 *
 * Backward-compat contract (ADR-040): a v1 (#208) payload carries its single
 * header/footer/style at the top level, and that IS the default variant. A v2
 * payload may instead carry `variants.default`. When both are present the
 * explicit `variants.default` wins (see the KNOWN AMBIGUITY test). Cross-scope
 * precedence/resolution is out of scope here (#304).
 */
export function defaultVariant(config: HeaderFooterComposition): HeaderFooterVariant {
  if (config.variants?.default) return config.variants.default;
  const variant: HeaderFooterVariant = {};
  if (config.header !== undefined) variant.header = config.header;
  if (config.footer !== undefined) variant.footer = config.footer;
  if (config.style !== undefined) variant.style = config.style;
  return variant;
}
