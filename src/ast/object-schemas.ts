import { z } from 'zod';

/**
 * Body-level DOCX objects SpecR models as an opaque, round-trip-preserving
 * blob rather than as inferred CSI structure (#300, ADR-072): a `w:tbl` table
 * or a `w:drawing`/`w:pict` text box. Everything else that can appear at body
 * level (chart, smartArt, OLE, image, unrecognized drawing) is DROPPED with a
 * `body-drawing-skipped` warning instead of captured — see
 * `parser/docx/body-drawings.ts` `DroppedDrawable`.
 */
export const ObjectKindSchema = z.enum(['table', 'textBox']);

/**
 * The OOXML drawing generation an object was authored in: DrawingML
 * (`w:drawing`, modern Word) or VML (`w:pict`, legacy/compat-mode Word).
 */
export const ObjectGenerationSchema = z.enum(['drawingml', 'vml']);

/**
 * One fast-xml-parser `preserveOrder: true` node's attribute record: flat
 * `{ '@_attrName': value }` pairs, values already coerced to string|number by
 * the parser (`parseAttributeValue`).
 */
const ObjectBlobAttributesSchema = z.record(z.string(), z.union([z.string(), z.number()]));

/**
 * JSON-safety-only mirror of ONE fast-xml-parser `preserveOrder: true` node:
 * a single-key element wrapper (`{ 'w:tbl': [...] }`) whose value is either
 * further child nodes or raw text (`{ '#text': 'hello' }`), plus an optional
 * `:@` key carrying the element's attributes. This is a capture format, not a
 * modeled AST — SpecR round-trips the blob byte-for-byte through the
 * generator without interpreting its OOXML content (ADR-072 decision 1), so
 * the type only needs to prove "this came from `JSON.parse`-safe data",
 * never a faithful OOXML grammar.
 */
export type ObjectBlobNode = Readonly<Record<string, readonly ObjectBlobNode[] | string>> & {
  readonly ':@'?: Readonly<Record<string, string | number>>;
};

/**
 * Recursive JSON-safety check backing {@link ObjectBlobNodeSchema}. A plain
 * `z.record`/`.catchall()` composition can't express "every key maps to
 * `ObjectBlobNode[] | string`, EXCEPT the literal `:@` key, which maps to a
 * flat attribute record" — that's two different value shapes keyed by name,
 * not a uniform index signature — so this validates it directly instead of
 * fighting zod's schema-composition surface for a genuinely heterogeneous
 * recursive shape.
 */
function isObjectBlobNode(value: unknown): value is ObjectBlobNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) =>
    key === ':@' ? isAttributeRecord(entry) : isChildValue(entry)
  );
}

function isAttributeRecord(value: unknown): boolean {
  return ObjectBlobAttributesSchema.safeParse(value).success;
}

function isChildValue(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every(isObjectBlobNode);
}

export const ObjectBlobNodeSchema: z.ZodType<ObjectBlobNode> = z.custom<ObjectBlobNode>(
  isObjectBlobNode,
  { message: 'invalid OOXML blob node: not a JSON-safe fast-xml-parser preserveOrder node' }
);

/**
 * Captured metadata for a body-level `object`/`objectText` SpecNode (ADR-072
 * decision 2). `rows`/`columns` are table-only (grid dimensions); `blob` is
 * the object's own top-level OOXML node(s) in document order, always
 * non-empty — an object with no captured content is never modeled at all.
 *
 * `vanishCharStyleIds` (#650) is the resolved set of character-style IDs
 * that carry an enabled `w:vanish` — i.e. the `StyleMap.vanishCharStyleIds`
 * a run's `w:rStyle` must resolve through to be treated as hidden. It is
 * captured alongside the object so capture (`collectText`) and the edit
 * rewrite path (`rewriteFirstText`) share one persisted source of truth
 * without needing `styles.xml` at rewrite time, where it is unavailable.
 * Additive JSONB field, no migration: an absent key and an empty array are
 * fully interchangeable (today's behaviour — no runs treated as hidden by
 * style), so a row captured before this change loads/edits unchanged.
 */
export const ObjectMetaSchema = z
  .object({
    kind: ObjectKindSchema,
    floating: z.boolean(),
    generation: ObjectGenerationSchema,
    rows: z.number().int().positive().exactOptional(),
    columns: z.number().int().positive().exactOptional(),
    vanishCharStyleIds: z.array(z.string()).exactOptional(),
    blob: z.array(ObjectBlobNodeSchema).check(z.minLength(1)),
  })
  .check((ctx) => {
    // rows/columns are table-grid dimensions; a textBox has no grid to
    // describe. Named fields only (kind, rows, columns) — this must never
    // scan for or react to other fields (vanishCharStyleIds included), so
    // future additive fields stay structurally untouched by this rule.
    const { kind, rows, columns } = ctx.value;
    if (kind !== 'textBox') return;
    const offendingKeys: string[] = [];
    if (rows !== undefined) offendingKeys.push('rows');
    if (columns !== undefined) offendingKeys.push('columns');
    if (offendingKeys.length === 0) return;
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: `textBox objects have no grid — ${offendingKeys.join(', ')} must not be set`,
    });
  });

export type ObjectKind = z.infer<typeof ObjectKindSchema>;
export type ObjectGeneration = z.infer<typeof ObjectGenerationSchema>;
export type ObjectMeta = z.infer<typeof ObjectMetaSchema>;
