// src/api/header-footer-body-limit-openapi.test.ts
//
// #490 (ADR-070) — the header/footer composition PUT routes are dispatched to
// a route-scoped JSON body limit (`HEADER_FOOTER_JSON_BODY_LIMIT_BYTES`,
// src/api/header-footer-body-limit.ts) instead of the REST-wide default, so a
// legitimately-sized composition write carrying a near-max-size image is not
// rejected by body-parser before Zod ever sees it. That limit — and the fact
// that exceeding it now surfaces as a documented 413, not an undocumented
// connection reset — must ALSO be mirrored in openapi.yaml, the hand-authored
// authoritative contract (ADR-026). This pins the sync the same way
// header-footer-image-cap-openapi.test.ts pins the per-image maxLength: change
// the derived constant without updating openapi.yaml and this fails first.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { HEADER_FOOTER_JSON_BODY_LIMIT_BYTES } from './header-footer-body-limit.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';

const OperationSchema = z.object({ responses: z.record(z.string(), z.unknown()) });
const PathItemSchema = z.object({
  get: OperationSchema.optional(),
  put: OperationSchema.optional(),
  delete: OperationSchema.optional(),
});
const RawSpecSchema = z.object({
  paths: z.record(z.string(), PathItemSchema),
  components: z.object({ responses: z.record(z.string(), z.unknown()) }),
});
const RefSchema = z.object({ $ref: z.string() });
const PayloadTooLargeResponseSchema = z.object({ description: z.string() });

const HEADER_FOOTER_PUT_PATHS = [
  '/libraries/{id}/header-footer',
  '/projects/{id}/header-footer',
  '/packages/{id}/header-footer',
  '/revisions/{id}/header-footer',
] as const;

const HEADER_FOOTER_RESOLVED_GET_PATHS = [
  '/projects/{id}/header-footer/resolved',
  '/packages/{id}/header-footer/resolved',
  '/revisions/{id}/header-footer/resolved',
] as const;

function getPathItem(raw: z.infer<typeof RawSpecSchema>, path: string) {
  const item = raw.paths[path];
  if (!item) throw new Error(`openapi.yaml is missing path ${path}`);
  return item;
}

describe('openapi.yaml — header/footer PUT 413 contract mirrors the body limit (#490)', () => {
  it.each(HEADER_FOOTER_PUT_PATHS)(
    '%s PUT documents a 413 -> PayloadTooLarge response',
    async (path) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      const put = getPathItem(raw, path).put;
      if (!put) throw new Error(`openapi.yaml is missing PUT ${path}`);
      const ref = RefSchema.parse(put.responses['413']);
      expect(ref.$ref).toBe('#/components/responses/PayloadTooLarge');
    }
  );

  it('components.responses.PayloadTooLarge description embeds the EXACT live byte limit (drift guard)', async () => {
    // A bare `.toContain(String(N))` substring check is unsound as a
    // byte-accuracy guard: it would still pass if the prose embedded a
    // DIFFERENT number that merely happens to contain N's digits as a
    // contiguous substring (e.g. N=7252652 "contained in" a typo'd
    // 17252652, or N re-embedded with a stray trailing digit) — none of
    // which is the number this response actually documents. Extract the
    // number from its known prose position and compare it EXACTLY instead.
    const raw = RawSpecSchema.parse(await loadRawSpec());
    const payloadTooLarge = PayloadTooLargeResponseSchema.parse(
      raw.components.responses.PayloadTooLarge
    );
    const match = /\blimit of (\d+) bytes\b/.exec(payloadTooLarge.description);
    if (!match) {
      throw new Error(
        'openapi.yaml PayloadTooLarge description no longer matches "limit of <N> bytes" — update this test\'s extraction pattern alongside any prose rewrite'
      );
    }
    const [, embeddedBytes] = match;
    expect(
      Number(embeddedBytes),
      'openapi.yaml PayloadTooLarge description drifted from HEADER_FOOTER_JSON_BODY_LIMIT_BYTES — update openapi.yaml when the derived limit changes'
    ).toBe(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES);
  });

  it('sibling GET/DELETE header-footer ops do not document a 413', async () => {
    const raw = RawSpecSchema.parse(await loadRawSpec());
    for (const path of HEADER_FOOTER_PUT_PATHS) {
      const item = getPathItem(raw, path);
      expect(item.get?.responses['413']).toBeUndefined();
      expect(item.delete?.responses['413']).toBeUndefined();
    }
  });

  it.each(HEADER_FOOTER_RESOLVED_GET_PATHS)(
    '%s (read-only resolved view) does not document a 413',
    async (path) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      const get = getPathItem(raw, path).get;
      if (!get) throw new Error(`openapi.yaml is missing GET ${path}`);
      expect(get.responses['413']).toBeUndefined();
    }
  );
});
