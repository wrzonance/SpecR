// src/api/header-footer-image-cap-openapi.test.ts
//
// #308 (ADR-069) — the header/footer image field's validation bounds are
// enforced by the Zod schema (src/ast/header-footer-schemas.ts) but must ALSO
// be mirrored in openapi.yaml, the hand-authored authoritative contract
// (ADR-026). The `imageData` `maxLength` is a hardcoded literal duplicating a
// DERIVED constant (`MAX_IMAGE_BASE64_LENGTH`, itself computed from
// `MAX_IMAGE_BYTES` in src/lib/image-media-type.ts), so nothing else would
// catch the contract going stale if that byte cap is ever changed. This pins
// the sync: change `MAX_IMAGE_BYTES` without updating openapi.yaml and this
// fails first. Also guards the `widthEmu`/`heightEmu` positive-integer bound.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';

// Navigate to the header/footer image field's inline schema. YAML anchors
// (`&headerFooterCell`) are resolved by the parser, so `header.left`'s cell
// carries the full field schema inline — no $ref dereferencing needed.
const FieldPropertiesSchema = z.object({
  components: z.object({
    schemas: z.object({
      HeaderFooterComposition: z.object({
        properties: z.object({
          header: z.object({
            properties: z.object({
              left: z.object({
                properties: z.object({
                  content: z.object({
                    items: z.object({
                      properties: z.object({
                        imageData: z.object({ maxLength: z.number() }),
                        widthEmu: z.object({ minimum: z.number() }),
                        heightEmu: z.object({ minimum: z.number() }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
});

describe('openapi.yaml — header/footer image field bounds mirror the Zod schema (#308)', () => {
  it('imageData maxLength equals MAX_IMAGE_BASE64_LENGTH (drift guard)', async () => {
    const raw = await loadRawSpec();
    const field =
      FieldPropertiesSchema.parse(raw).components.schemas.HeaderFooterComposition.properties.header
        .properties.left.properties.content.items.properties;
    expect(
      field.imageData.maxLength,
      'openapi.yaml imageData.maxLength drifted from MAX_IMAGE_BASE64_LENGTH — update openapi.yaml when MAX_IMAGE_BYTES changes'
    ).toBe(MAX_IMAGE_BASE64_LENGTH);
  });

  it('widthEmu/heightEmu require positive integers', async () => {
    const raw = await loadRawSpec();
    const field =
      FieldPropertiesSchema.parse(raw).components.schemas.HeaderFooterComposition.properties.header
        .properties.left.properties.content.items.properties;
    expect(field.widthEmu.minimum).toBe(1);
    expect(field.heightEmu.minimum).toBe(1);
  });
});
