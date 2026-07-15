import { describe, it, expect } from 'vitest';
import {
  HeaderFooterCompositionSchema,
  HeaderFooterCompositionWriteSchema,
  HeaderFooterUnmodeledEntrySchema,
  PageNumberingModeSchema,
  defaultVariant,
} from './header-footer-schemas.js';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import { HEADER_FOOTER_JSON_BODY_LIMIT_BYTES } from '../lib/header-footer-body-limit.js';

// #302 (parent #301): extend the v1 composition (#208) with Word-style page
// variants, a page-numbering policy, and an open `raw` sidecar — without
// breaking any existing v1 `{ header, footer, style }` payload.

describe('HeaderFooterCompositionSchema — v1 backward compatibility (#208 → default variant)', () => {
  it('still validates a v1 { header, footer, style } payload unchanged', () => {
    const v1 = {
      header: {
        left: { content: [{ kind: 'clientName' }] },
        center: { content: [{ kind: 'sectionNumber' }, { kind: 'sectionTitle' }] },
        style: { fontFamily: 'Arial', fontSizeHalfPt: 18 },
        ruleLine: { enabled: true, widthTwips: 8 },
      },
      footer: {
        right: { content: [{ kind: 'pageNumber', label: 'Page' }] },
      },
      style: { fontFamily: 'Arial' },
    };
    expect(HeaderFooterCompositionSchema.parse(v1)).toEqual(v1);
  });

  it('treats the v1 top-level header/footer/style AS the default variant', () => {
    // Documents the v1→default compatibility contract: with no explicit
    // `variants.default`, the legacy top-level fields ARE the default variant.
    const v1 = {
      header: { center: { content: [{ kind: 'sectionTitle' }] } },
      footer: { right: { content: [{ kind: 'pageNumber' }] } },
      style: { bold: true },
    };
    const config = HeaderFooterCompositionSchema.parse(v1);
    expect(defaultVariant(config)).toEqual({
      header: v1.header,
      footer: v1.footer,
      style: v1.style,
    });
  });

  it('round-trips the #208 open .catchall extension keys (vendor/client tokens)', () => {
    const v1Open = {
      header: {
        left: { content: [{ kind: 'clientName' }] },
        style: { fontFamily: 'Arial', clientToken: 'acme' },
        ruleLine: { enabled: true, futureRule: { colorMode: 'theme' } },
      },
      footer: { right: { content: [{ kind: 'pageNumber', fallback: 'name' }] } },
      vendorExtension: { layoutPreset: 'client-a' },
    };
    expect(HeaderFooterCompositionSchema.parse(v1Open)).toEqual(v1Open);
  });
});

describe('HeaderFooterCompositionSchema — v2 variants (default/first/even)', () => {
  it('validates default/first/even variants and round-trips unknown keys', () => {
    const v2 = {
      variants: {
        default: { header: { center: { content: [{ kind: 'sectionTitle' }] } } },
        first: { header: { center: { content: [{ kind: 'literal', text: 'COVER' }] } } },
        even: { footer: { left: { content: [{ kind: 'pageNumber' }] } } },
      },
      raw: {
        warnings: ['unsupported w:fldSimple in odd footer'],
        capturedOoxml: { 'header2.xml': '<w:hdr/>' },
      },
      vendorExtension: { layoutPreset: 'duplex' },
    };
    expect(HeaderFooterCompositionSchema.parse(v2)).toEqual(v2);
  });

  it('prefers an explicit variants.default over v1 top-level fields', () => {
    const config = HeaderFooterCompositionSchema.parse({
      header: { center: { content: [{ kind: 'literal', text: 'V1' }] } },
      variants: {
        default: { header: { center: { content: [{ kind: 'literal', text: 'V2' }] } } },
      },
    });
    // KNOWN AMBIGUITY: a payload may carry BOTH the v1 top-level fields and an
    // explicit `variants.default`. OOXML has no canonical answer for which
    // wins; SpecR (ADR-040) defines the explicit `variants.default` as
    // authoritative so a v2 caller can deliberately override an inherited v1
    // layer. Cross-scope precedence/resolution is out of scope here (#304).
    expect(defaultVariant(config)).toEqual({
      header: { center: { content: [{ kind: 'literal', text: 'V2' }] } },
    });
  });
});

describe('HeaderFooterCompositionSchema — pageNumbering policy', () => {
  it('accepts mode "continuous" with an optional startAt', () => {
    const input = { pageNumbering: { mode: 'continuous', startAt: 1 } };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('accepts mode "restartPerSpec" without startAt', () => {
    const input = { pageNumbering: { mode: 'restartPerSpec' } };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('exposes both modes via PageNumberingModeSchema', () => {
    expect(PageNumberingModeSchema.parse('continuous')).toBe('continuous');
    expect(PageNumberingModeSchema.parse('restartPerSpec')).toBe('restartPerSpec');
  });

  it('rejects an unknown pageNumbering mode', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({ pageNumbering: { mode: 'perPage' } })
    ).toThrow();
  });

  it('rejects a non-integer startAt', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({ pageNumbering: { mode: 'continuous', startAt: 'one' } })
    ).toThrow();
  });
});

describe('HeaderFooterCompositionSchema — typed fields still fail validation', () => {
  it('rejects an invalid header field kind (catchall must not swallow typed-field errors)', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        header: { left: { content: [{ kind: 'notARealKind' }] } },
      })
    ).toThrow();
  });

  it('rejects an invalid field kind nested inside a v2 variant', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        variants: { first: { footer: { right: { content: [{ kind: 'bogus' }] } } } },
      })
    ).toThrow();
  });
});

describe('HeaderFooterCompositionSchema — reserved-key promotion (ADR-040 caveat)', () => {
  it('h/f schema: v2 reserves variants/pageNumbering/raw — non-colliding v1 extension keys still validate; a colliding legacy value is the typed field (ADR-040 caveat)', () => {
    // General backward-compat holds: a v1 payload with an arbitrary, non-colliding
    // .catchall extension key still validates and round-trips it untouched.
    const v1WithExtension = {
      header: { center: { content: [{ kind: 'sectionTitle' }] } },
      footer: { right: { content: [{ kind: 'pageNumber' }] } },
      style: { fontFamily: 'Arial' },
      someClientKey: { layoutPreset: 'acme', nested: { flag: true } },
    };
    expect(HeaderFooterCompositionSchema.parse(v1WithExtension)).toEqual(v1WithExtension);

    // Accepted migration caveat: v2 promotes `variants`/`pageNumbering`/`raw`
    // from open extension keys to RESERVED typed keys. A payload using one of
    // those names is now parsed as the typed field — a CONFORMING value passes...
    const conforming = { pageNumbering: { mode: 'continuous', startAt: 1 } };
    expect(HeaderFooterCompositionSchema.parse(conforming)).toEqual(conforming);

    // ...and a NON-conforming legacy value under that reserved name now rejects
    // at the boundary (the documented, deliberate behavior — tolerant parsing
    // was rejected so invalid typed fields can never slip through; see ADR-040).
    expect(() =>
      HeaderFooterCompositionSchema.parse({ pageNumbering: { vendorPolicy: true } })
    ).toThrow();
    expect(() => HeaderFooterCompositionSchema.parse({ raw: '<w:hdr/>' })).toThrow();
    expect(() => HeaderFooterCompositionSchema.parse({ variants: 'legacy-string' })).toThrow();
  });
});

// #306 (ADR-068): every unsupported/unrecognized header/footer content item
// must be captured into `raw.unmodeled` (JSON-safe) and reflected as one line
// in `raw.warnings` — never silently dropped. This pins the schema boundary
// that guarantee is built on: `raw.unmodeled` is additive and backward
// compatible with every pre-#306 `HeaderFooterComposition` value.
describe('HeaderFooterCompositionSchema — raw.unmodeled sidecar (#306, ADR-068)', () => {
  it('captures an unmodeled entry for each of the six kinds, JSON-safe, alongside its warning', () => {
    const kinds = [
      'image',
      'table',
      'unrecognizedField',
      'unresolvedReference',
      'extraParagraph',
      'inactiveVariant',
    ] as const;
    const input = {
      raw: {
        warnings: kinds.map((kind) => `unsupported ${kind} in header/footer`),
        unmodeled: kinds.map((kind) => ({
          variant: 'default' as const,
          region: 'header' as const,
          kind,
          detail: { note: `${kind} fragment`, nested: { safe: true } },
        })),
      },
    };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('rejects an unmodeled entry with an unrecognized kind', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        raw: {
          unmodeled: [{ variant: 'default', region: 'header', kind: 'notAKind', detail: {} }],
        },
      })
    ).toThrow();
  });

  it('rejects an unmodeled entry missing a required field', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        raw: { unmodeled: [{ region: 'header', kind: 'image', detail: {} }] },
      })
    ).toThrow();
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        raw: { unmodeled: [{ variant: 'default', region: 'header', kind: 'image' }] },
      })
    ).toThrow();
  });

  it('exposes HeaderFooterUnmodeledEntrySchema standalone for parser-side construction', () => {
    const entry = {
      variant: 'first' as const,
      region: 'footer' as const,
      kind: 'inactiveVariant' as const,
      detail: { reason: 'w:evenAndOddHeaders absent' },
    };
    expect(HeaderFooterUnmodeledEntrySchema.parse(entry)).toEqual(entry);
  });

  it('still validates a pre-#306 raw sidecar carrying only `warnings`, with no `unmodeled` key', () => {
    const preExisting = {
      raw: {
        warnings: ['unsupported w:fldSimple in odd footer'],
        capturedOoxml: { 'header2.xml': '<w:hdr/>' },
      },
    };
    const parsed = HeaderFooterCompositionSchema.parse(preExisting);
    expect(parsed).toEqual(preExisting);
    expect(parsed.raw?.unmodeled).toBeUndefined();
  });
});

// #308 (ADR-069): `kind: 'image'` header/footer fields. The schema boundary never
// trusts a caller-declared `imageMediaType` — the generator re-sniffs the actual
// bytes (src/lib/image-media-type.ts) and picks the docx `ImageRun` type off the
// sniff result, never the declared value — so ANY string here (including an
// unsupported one) is structurally valid and round-trips; the ONLY thing that
// rejects an image field is the `imageData` base64-length cap.
describe('HeaderFooterCompositionSchema — image fields (#308, ADR-069)', () => {
  it('accepts an image field with an open/unsupported imageMediaType and an unrelated catchall key, and round-trips both', () => {
    const input = {
      header: {
        center: {
          content: [
            {
              kind: 'image',
              imageData: 'AAAA',
              imageMediaType: 'image/svg+xml', // unsupported by docx's ImageRun — still valid here
              widthEmu: 914400,
              heightEmu: 914400,
              altText: 'Company logo',
              rotationDegrees: 90, // open .catchall extension key (ADR-021)
            },
          ],
        },
      },
    };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('accepts an image field with only imageData set — missing dimensions/altText validate (they just do not render)', () => {
    const input = { header: { left: { content: [{ kind: 'image', imageData: 'AAAA' }] } } };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('accepts imageData exactly at the MAX_IMAGE_BASE64_LENGTH cap', () => {
    const imageData = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH);
    const input = { header: { left: { content: [{ kind: 'image', imageData }] } } };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('rejects imageData one character past the MAX_IMAGE_BASE64_LENGTH cap', () => {
    const imageData = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 1);
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        header: { left: { content: [{ kind: 'image', imageData }] } },
      })
    ).toThrow();
  });

  it('still rejects an unrecognized field kind now that "image" is a valid kind (catchall must not swallow typed-field errors)', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        header: { left: { content: [{ kind: 'imagex' }] } },
      })
    ).toThrow();
  });
});

// #309 (ADR-071): a table/grid layout for header/footer content, as a new
// sibling slot on HeaderFooterRegionSchema alongside left/center/right — not
// a replacement for the paragraph model. Cell content reuses the existing
// 13-kind HeaderFooterFieldSchema, cell/table style reuses
// HeaderFooterVisualStyleSchema, and table borders reuse
// HeaderFooterRuleLineSchema verbatim (ADR-021 "known keys typed, unknown
// keys open" posture kept uniform, no parallel schema family for tables).
describe('HeaderFooterCompositionSchema — table content (#309, ADR-071)', () => {
  it('accepts a region.table with rows/cells, mixed field content, and round-trips open extension keys at every level (ADR-021 openness)', () => {
    const input = {
      footer: {
        table: {
          rows: [
            {
              cells: [
                {
                  content: [{ kind: 'literal', text: 'Drawing No.' }],
                  columnSpan: 2,
                  style: { bold: true },
                },
                { content: [{ kind: 'pageNumber' }], separator: ' of ' },
              ],
              rowVendorKey: 'vendor-a',
            },
          ],
          columnWidths: [4500, 2500],
          borders: { enabled: true, widthTwips: 8, color: '000000' },
          tableVendorKey: { nested: true },
        },
      },
    };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('rejects a table with zero rows (a table with no rows is a fabricated shape, not a valid one)', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({ footer: { table: { rows: [] } } })
    ).toThrow();
  });

  it('rejects a table row whose cells is not an array', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        footer: { table: { rows: [{ cells: 'not-an-array' }] } },
      })
    ).toThrow();
  });

  it('rejects an invalid field kind nested inside table cell content (catchall must not swallow typed-field errors)', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        footer: { table: { rows: [{ cells: [{ content: [{ kind: 'bogus' }] }] }] } },
      })
    ).toThrow();
  });

  it('enforces the imageData base64-length cap on an image field nested inside a table cell', () => {
    const imageData = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 1);
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        footer: { table: { rows: [{ cells: [{ content: [{ kind: 'image', imageData }] }] }] } },
      })
    ).toThrow();
  });

  it('rejects a non-positive columnSpan and a non-positive columnWidths entry', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        footer: { table: { rows: [{ cells: [{ columnSpan: 0 }] }] } },
      })
    ).toThrow();
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        footer: { table: { rows: [{ cells: [{}] }], columnWidths: [0] } },
      })
    ).toThrow();
  });

  it('rejects a non-integer borders.widthTwips (borders reuses HeaderFooterRuleLineSchema verbatim)', () => {
    expect(() =>
      HeaderFooterCompositionSchema.parse({
        footer: { table: { rows: [{ cells: [{}] }], borders: { widthTwips: 1.5 } } },
      })
    ).toThrow();
  });

  it('a region can carry both a paragraph (left/center/right) and a table together, in that order', () => {
    const input = {
      footer: {
        left: { content: [{ kind: 'literal', text: 'Approved by:' }] },
        table: {
          rows: [{ cells: [{ content: [{ kind: 'literal', text: 'Sheet 1 of 3' }] }] }],
        },
      },
    };
    expect(HeaderFooterCompositionSchema.parse(input)).toEqual(input);
  });

  it('still validates a pre-#309 region with no table key (additive-optional, backward compatible)', () => {
    const preExisting = { header: { center: { content: [{ kind: 'sectionTitle' }] } } };
    expect(HeaderFooterCompositionSchema.parse(preExisting)).toEqual(preExisting);
  });
});

// Code-review finding (#490 follow-up): every level of the composition is
// `.catchall(JsonValue)` (ADR-021 open extensions), which has no size bound
// of its own. Without a total-size invariant, a request that Zod would call
// "valid" could still carry unbounded open-extension data and exceed
// `HEADER_FOOTER_JSON_BODY_LIMIT_BYTES` (src/api/header-footer-body-limit.ts,
// derived from `MAX_IMAGE_BASE64_LENGTH` + envelope) — the transport limit
// ADR-070 sized for exactly one image plus a modest envelope. The invariant is
// enforced on the WRITE schema only: a WRITE is a single transport request, so
// "Zod-valid write" and "fits the transport limit" must never diverge. The
// structural schema (reads/resolution/DOCX capture) deliberately omits it — a
// second review pass found that enforcing it there turned a merged multi-layer
// resolution read into a 500 (see the "structural schema tolerates oversize"
// case below).
describe('HeaderFooterCompositionWriteSchema — total-size invariant matches the transport limit (#490)', () => {
  it('rejects a structurally-valid composition whose open .catchall extension data alone exceeds HEADER_FOOTER_JSON_BODY_LIMIT_BYTES', () => {
    // No image anywhere — every typed field is absent. Only an open extension
    // key (ADR-021) carries size, and it alone is already past the transport
    // budget. Pre-fix, the write schema accepted this (catchall(JsonValue) has
    // no size bound); the resulting payload would still 413 at body-parser,
    // defeating the "Zod-valid write always fits" invariant
    // HEADER_FOOTER_JSON_BODY_LIMIT_BYTES exists to guarantee.
    const oversizedExtension = 'A'.repeat(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES);
    expect(() =>
      HeaderFooterCompositionWriteSchema.parse({ vendorExtension: oversizedExtension })
    ).toThrow();
  });

  // Regression (#490 follow-up, 2nd review): the transport-size invariant must
  // NOT live on the shared structural schema. Reads/resolution re-parse through
  // HeaderFooterCompositionSchema — a merged multi-layer resolution combines
  // several independently-valid layers (each written within the budget) and can
  // legitimately exceed HEADER_FOOTER_JSON_BODY_LIMIT_BYTES. Enforcing the write
  // budget there rejected the merged read and surfaced as a 500
  // (src/api/header-footer-resolve.ts). The structural schema must tolerate it.
  it('structural HeaderFooterCompositionSchema accepts an oversized composition (a merged resolution read never inherits the write transport budget)', () => {
    const oversizedExtension = 'A'.repeat(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES + 1);
    const parsed = HeaderFooterCompositionSchema.parse({ vendorExtension: oversizedExtension });
    expect(parsed).toEqual({ vendorExtension: oversizedExtension });
  });

  it('rejects when the overage is spread across many nested .catchall levels rather than one field', () => {
    // Region/cell/field/variant catchalls are all nested inside the same
    // top-level object, so a size invariant enforced once at the top still
    // has to catch overage contributed by ANY of them combined — not just a
    // single offending key.
    // Sized just past HEADER_FOOTER_JSON_BODY_LIMIT_BYTES (~7.25 MB): six 1 MB
    // nested vendor tokens (6 MB) plus two 1 MB warning entries (2 MB) ≈ 8 MB,
    // so the overage is genuinely distributed across nested catchalls rather
    // than carried by one field — without allocating the ~60 MB an oversized
    // warnings array would cost.
    const chunk = 'A'.repeat(1_000_000);
    const input = {
      header: {
        left: { style: { vendorTokenA: chunk } },
        center: { style: { vendorTokenB: chunk } },
        right: { style: { vendorTokenC: chunk } },
      },
      variants: {
        default: { style: { vendorTokenD: chunk } },
        first: { style: { vendorTokenE: chunk } },
        even: { style: { vendorTokenF: chunk } },
      },
      raw: { warnings: [chunk, chunk] },
    };
    expect(() => HeaderFooterCompositionWriteSchema.parse(input)).toThrow();
  });

  it('still accepts a genuine one-image composition (the case the transport limit is sized for) plus a small extension', () => {
    const imageData = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH);
    const input = {
      header: { left: { content: [{ kind: 'image', imageData }] } },
      vendorExtension: { note: 'firm-logo-v2' },
    };
    expect(HeaderFooterCompositionWriteSchema.parse(input)).toEqual(input);
  });

  // Merge integration (#309 table shapes × #490 write-size invariant): the write
  // schema is the shared structural schema PLUS `.check`, so it must accept the
  // new region.table shapes untouched AND still enforce the transport budget
  // against open-extension data nested inside a table cell — the budget is a
  // top-level check, so table-cell catchall size counts toward it.
  it('accepts a table-bearing composition within budget and trips the size check on oversized table-cell extension data', () => {
    const within = {
      footer: {
        table: { rows: [{ cells: [{ content: [{ kind: 'literal', text: 'Sheet 1 of 3' }] }] }] },
      },
    };
    expect(HeaderFooterCompositionWriteSchema.parse(within)).toEqual(within);

    const oversized = {
      footer: {
        table: {
          rows: [{ cells: [{ vendorBlob: 'A'.repeat(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES) }] }],
        },
      },
    };
    expect(() => HeaderFooterCompositionWriteSchema.parse(oversized)).toThrow();
  });
});
