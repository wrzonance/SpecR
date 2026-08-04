import { z } from 'zod';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import { codePointMax } from '../lib/length-limit.js';
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
    // The cap is a plain string length with NO base64 pattern behind it (malformed
    // payloads round-trip by design, see above), so the field's alphabet is not
    // actually constrained to RFC 4648 ASCII. codePointMax (#642, ADR-091) bounds
    // and publishes this in UNICODE CODE POINTS — the unit the openapi.yaml
    // `maxLength` keyword this bound is published as actually means.
    imageData: codePointMax(z.string(), MAX_IMAGE_BASE64_LENGTH, {
      message: `imageData exceeds the ${MAX_IMAGE_BASE64_LENGTH}-code-point base64 size cap`,
      description:
        'Base64-encoded image bytes. The cap is a plain string length with no ' +
        'base64 pattern behind it, so the alphabet is not actually constrained to ASCII.',
    }).exactOptional(),
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

// A table/grid layout for header/footer content (#309, ADR-071) — a new
// sibling slot on HeaderFooterRegionSchema, not a replacement for the
// left/center/right paragraph model (a region may carry both). Cell content
// reuses the existing 13-kind HeaderFooterFieldSchema verbatim (the
// "no images in table cells" rule is enforced at render time, not by a
// second field schema); cell/table style reuses HeaderFooterVisualStyleSchema;
// table borders reuse HeaderFooterRuleLineSchema verbatim, applied uniformly
// to all six docx ITableBordersOptions edges by the generator.
const HeaderFooterTableCellSchema = z
  .object({
    content: z.array(HeaderFooterFieldSchema).exactOptional(),
    columnSpan: z.number().int().positive().exactOptional(),
    separator: z.string().exactOptional(),
    style: HeaderFooterVisualStyleSchema.exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterTableRowSchema = z
  .object({ cells: z.array(HeaderFooterTableCellSchema) })
  .catchall(JsonValue);

const HeaderFooterTableSchema = z
  .object({
    rows: z.array(HeaderFooterTableRowSchema).min(1),
    columnWidths: z.array(z.number().int().positive()).exactOptional(),
    borders: HeaderFooterRuleLineSchema.exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterRegionSchema = z
  .object({
    left: HeaderFooterCellSchema.exactOptional(),
    center: HeaderFooterCellSchema.exactOptional(),
    right: HeaderFooterCellSchema.exactOptional(),
    style: HeaderFooterVisualStyleSchema.exactOptional(),
    ruleLine: HeaderFooterRuleLineSchema.exactOptional(),
    table: HeaderFooterTableSchema.exactOptional(),
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

// Structural composition schema — the canonical AST shape (ADR-021 open
// extensions at every level). Deliberately carries NO transport-size bound: it
// is the schema every READ/parse path re-parses through — DB resolution merges
// (`src/db/queries/header-footer.ts`) and DOCX capture
// (`src/parser/docx/header-footer.ts`) — where a value can legitimately exceed
// the per-write transport budget. A merged multi-layer resolution combines
// several independently-valid layers (each written within the budget), and a
// captured DOCX header carries whatever image the document holds; neither is a
// single transport request, so neither may inherit
// `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`. Enforcing it here would turn a valid
// read into a 500 (#490 follow-up review). The size invariant lives ONLY on
// `HeaderFooterCompositionWriteSchema` below.
export const HeaderFooterCompositionSchema = z
  .object({
    // v1 (#208) fields — preserved; read as the `default` variant (ADR-040).
    ...variantShape,
    // v2 (#302) fields.
    variants: HeaderFooterVariantsSchema.exactOptional(),
    pageNumbering: PageNumberingSchema.exactOptional(),
    raw: HeaderFooterRawSidecarSchema.exactOptional(),
  })
  .catchall(JsonValue);

// Write-path schema: the structural schema PLUS the transport-size invariant.
// Applied ONLY where a composition arrives as a single request body that must
// fit `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES` — the four `PUT .../header-footer`
// routes (`validateBody`, `src/api/router.ts`) and the MCP `set_*_header_footer`
// write tools (`src/mcp/header-footer-handlers.ts`). Every level above is
// `.catchall(JsonValue)` (ADR-021) with no per-field size bound, so a
// structurally-valid composition could still carry unbounded open-extension
// data; this one top-level check keeps a Zod-valid WRITE always within the
// budget the route-local `express.json({limit})` / `/mcp` transport limits also
// enforce — without imposing that budget on reads/resolution. (#490 follow-up;
// ADR-070.)
export const HeaderFooterCompositionWriteSchema = HeaderFooterCompositionSchema.check((ctx) => {
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
