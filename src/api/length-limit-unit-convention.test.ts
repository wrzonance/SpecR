// src/api/length-limit-unit-convention.test.ts
//
// #626 (ADR-088) — Zod's `.max(n)` delegates to `String.prototype.length`
// (UTF-16 code units); JSON Schema's `maxLength` keyword (used by every
// `openapi.yaml` field it mirrors) is defined in Unicode code points. For
// any character outside the Basic Multilingual Plane the two counts diverge
// by up to 2x, so a spec-compliant client can construct a payload the
// documented contract says is valid but the server 422s. ADR-088 chose
// "accept and document" over changing enforcement: every paired site's
// `openapi.yaml` description states the UTF-16 convention verbatim
// (`UTF16_LENGTH_LIMIT_NOTE`).
//
// This file has two jobs, mirroring the established `*-openapi.test.ts`
// idiom (see header-footer-image-cap-openapi.test.ts,
// language-rules-literal-bounds-openapi.test.ts):
//
// 1. Drift guard — every in-scope site's `openapi.yaml` description contains
//    the canonical note verbatim and its `maxLength` matches the expected
//    bound, so the prose and the spec cannot silently diverge.
// 2. Boundary pin — a representative sample of the *unchanged* Zod
//    validators is exercised at the UTF-16 boundary with a non-BMP
//    character (U+1F600, 2 UTF-16 units per code point) to pin the current
//    counting behavior as a regression guard, not a behavior change.
//
// sha256 (openapi.yaml, fixed 64-char hex digest) and imageData (base64
// byte-size cap) are deliberately excluded from the drift guard above —
// both alphabets are ASCII-only, so UTF-16-unit count and Unicode-code-point
// count are always identical there. See ADR-088 for the full inventory and
// reasoning. That exclusion is itself pinned below: each site's maxLength is
// asserted unchanged and its description is asserted to NOT carry
// UTF16_LENGTH_LIMIT_NOTE, so an edit that accidentally moves either field
// into ADR-088's scope (or drifts its maxLength) fails loudly instead of
// going unpinned.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { UTF16_LENGTH_LIMIT_NOTE } from '../lib/length-limit-note.js';
import { ActorLabelSchema } from '../ast/index.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';
import { VerificationBodySchema } from './standards.js';
import { ResolveUserBody } from './users.js';
import { ResolveUserShape } from '../mcp/users-handlers.js';
import { RecordStandardVerificationShape } from '../mcp/standards-handlers.js';

// A non-BMP character: U+1F600 GRINNING FACE, 1 Unicode code point, 2 UTF-16
// code units (a surrogate pair). Repeating it N times yields a string whose
// `.length` (UTF-16 units) is 2N and whose `[...str].length` (code points)
// is N — the exact divergence ADR-088 documents.
const ASTRAL_CHAR = '\u{1F600}';

const DescribedLengthFieldSchema = z.object({
  maxLength: z.number(),
  description: z.string(),
});

// sha256/imageData carry no ADR-088 note (they're out of scope), and sha256
// has no `description` key at all — description is optional here, unlike
// DescribedLengthFieldSchema above.
const AsciiOnlyLengthFieldSchema = z.object({
  maxLength: z.number(),
  description: z.string().optional(),
});

const RawSpecSchema = z.object({
  paths: z.object({
    '/users': z.object({
      post: z.object({
        requestBody: z.object({
          content: z.object({
            'application/json': z.object({
              schema: z.object({
                properties: z.object({ label: DescribedLengthFieldSchema }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
  components: z.object({
    schemas: z.object({
      ActorLabel: DescribedLengthFieldSchema,
      LanguageRuleTermWrite: z.object({
        allOf: z.tuple([
          z.unknown(),
          z.object({ properties: z.object({ term: DescribedLengthFieldSchema }) }),
        ]),
      }),
      StandardVerificationBody: z.object({
        properties: z.object({
          currentVersion: DescribedLengthFieldSchema,
          sourceUrl: DescribedLengthFieldSchema,
          title: DescribedLengthFieldSchema,
          notes: DescribedLengthFieldSchema,
        }),
      }),
      SpecLineage: z.object({
        properties: z.object({
          originMeta: z.object({
            oneOf: z.tuple([
              z.object({
                properties: z.object({ sha256: AsciiOnlyLengthFieldSchema }),
              }),
              z.unknown(),
            ]),
          }),
        }),
      }),
      HeaderFooterComposition: z.object({
        properties: z.object({
          header: z.object({
            properties: z.object({
              left: z.object({
                properties: z.object({
                  content: z.object({
                    items: z.object({
                      properties: z.object({ imageData: AsciiOnlyLengthFieldSchema }),
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
type RawSpec = z.infer<typeof RawSpecSchema>;

interface LengthLimitSite {
  name: string;
  expectedMax: number;
  select: (spec: RawSpec) => { maxLength: number; description: string };
}

const LENGTH_LIMIT_SITES: readonly LengthLimitSite[] = [
  {
    name: 'POST /users label (request body)',
    expectedMax: 200,
    select: (spec) =>
      spec.paths['/users'].post.requestBody.content['application/json'].schema.properties.label,
  },
  {
    name: 'ActorLabel',
    expectedMax: 200,
    select: (spec) => spec.components.schemas.ActorLabel,
  },
  {
    name: 'LanguageRuleTermWrite.term',
    expectedMax: 500,
    select: (spec) => spec.components.schemas.LanguageRuleTermWrite.allOf[1].properties.term,
  },
  {
    name: 'StandardVerificationBody.currentVersion',
    expectedMax: 200,
    select: (spec) => spec.components.schemas.StandardVerificationBody.properties.currentVersion,
  },
  {
    name: 'StandardVerificationBody.sourceUrl',
    expectedMax: 2000,
    select: (spec) => spec.components.schemas.StandardVerificationBody.properties.sourceUrl,
  },
  {
    name: 'StandardVerificationBody.title',
    expectedMax: 500,
    select: (spec) => spec.components.schemas.StandardVerificationBody.properties.title,
  },
  {
    name: 'StandardVerificationBody.notes',
    expectedMax: 5000,
    select: (spec) => spec.components.schemas.StandardVerificationBody.properties.notes,
  },
];

interface AsciiOnlyExcludedSite {
  name: string;
  expectedMax: number;
  select: (spec: RawSpec) => { maxLength: number; description?: string | undefined };
}

const ASCII_ONLY_EXCLUDED_SITES: readonly AsciiOnlyExcludedSite[] = [
  {
    name: 'SpecLineage.originMeta.sha256 (fixed 64-char hex digest)',
    expectedMax: 64,
    select: (spec) =>
      spec.components.schemas.SpecLineage.properties.originMeta.oneOf[0].properties.sha256,
  },
  {
    name: 'HeaderFooterComposition header.left.content[].imageData (base64 image bytes, ADR-069)',
    expectedMax: 6990508,
    select: (spec) =>
      spec.components.schemas.HeaderFooterComposition.properties.header.properties.left.properties
        .content.items.properties.imageData,
  },
];

describe('openapi.yaml — length-limit unit convention is documented at every paired site (#626, ADR-088)', () => {
  it.each(LENGTH_LIMIT_SITES)(
    '$name: maxLength matches the Zod bound and the description states the UTF-16 convention',
    async ({ expectedMax, select }) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      const field = select(raw);
      expect(
        field.maxLength,
        'openapi.yaml maxLength drifted from the paired Zod .max() bound'
      ).toBe(expectedMax);
      expect(
        field.description,
        'openapi.yaml description must state the UTF-16 length-limit convention verbatim (ADR-088) — ' +
          'a reader of this field alone must not assume JSON Schema maxLength code-point semantics'
      ).toContain(UTF16_LENGTH_LIMIT_NOTE);
    }
  );
});

describe('openapi.yaml — ASCII-only sites stay excluded from the ADR-088 note (#626)', () => {
  it.each(ASCII_ONLY_EXCLUDED_SITES)(
    '$name: maxLength is pinned and the description does not carry the UTF-16 note',
    async ({ expectedMax, select }) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      const field = select(raw);
      expect(
        field.maxLength,
        'openapi.yaml maxLength drifted for an ASCII-only field ADR-088 deliberately excludes'
      ).toBe(expectedMax);
      expect(
        field.description ?? '',
        'this field is ASCII-only (UTF-16-unit count == Unicode-code-point count), so it must never carry ' +
          'UTF16_LENGTH_LIMIT_NOTE — if it does, ADR-088 scope has drifted and this site belongs in ' +
          'LENGTH_LIMIT_SITES above instead'
      ).not.toContain(UTF16_LENGTH_LIMIT_NOTE);
    }
  );
});

// The MCP twins of these REST sites are NOT reuses of the REST validators —
// `ResolveUserShape` (src/mcp/users-handlers.ts) and
// `RecordStandardVerificationShape` (src/mcp/standards-handlers.ts) each
// declare their own `.max(n)` literals. Because those are declarative Zod
// checks, the MCP SDK's schema generator copies both the bound and the
// `.describe()` prose into each tool's published JSON Schema — so an MCP
// client sees a machine-readable `maxLength: n` with exactly the code-point
// semantics ADR-088 documents as wrong. Leaving the note off that surface
// would make #626 a partial fix, which the issue calls out as worse than
// none. These pin the note and the bound on the MCP side too.
interface McpTwinSite {
  name: string;
  expectedMax: number;
  field: { description?: string | undefined; safeParse: (v: unknown) => { success: boolean } };
  /** URL-format fields can't take astral padding — pin their bound in ASCII. */
  probe: 'astral' | 'ascii-url';
}

const MCP_TWIN_SITES: readonly McpTwinSite[] = [
  {
    name: 'resolve_user.label',
    expectedMax: 200,
    field: ResolveUserShape.label,
    probe: 'astral',
  },
  {
    name: 'record_standard_verification.currentVersion',
    expectedMax: 200,
    field: RecordStandardVerificationShape.currentVersion,
    probe: 'astral',
  },
  {
    name: 'record_standard_verification.sourceUrl',
    expectedMax: 2000,
    field: RecordStandardVerificationShape.sourceUrl,
    probe: 'ascii-url',
  },
  {
    name: 'record_standard_verification.title',
    expectedMax: 500,
    field: RecordStandardVerificationShape.title,
    probe: 'astral',
  },
  {
    name: 'record_standard_verification.notes',
    expectedMax: 5000,
    field: RecordStandardVerificationShape.notes,
    probe: 'astral',
  },
];

/** A string of exactly `units` UTF-16 code units for the given probe style. */
function probeString(probe: McpTwinSite['probe'], units: number): string {
  if (probe === 'ascii-url') {
    const prefix = 'https://example.com/';
    return prefix + 'a'.repeat(units - prefix.length);
  }
  // Astral: 2 UTF-16 units per code point, plus one ASCII filler when odd.
  return ASTRAL_CHAR.repeat(Math.floor(units / 2)) + (units % 2 === 1 ? 'x' : '');
}

// Note-presence across the WHOLE MCP surface is asserted by the invariant sweep
// in src/mcp/length-limit-unit-convention.test.ts. What that sweep cannot see is
// whether each twin's bound still MATCHES its REST counterpart and is still
// counted in UTF-16 units — a twin silently drifting to .max(199), or to a
// code-point check, would keep its note and pass there. That is this block's job.
describe('MCP tool shapes — twin length bounds stay identical to their REST counterparts (#626)', () => {
  it.each(MCP_TWIN_SITES)(
    '$name: bound is $expectedMax UTF-16 code units, matching its REST twin',
    ({ expectedMax, field, probe }) => {
      const atLimit = probeString(probe, expectedMax);
      const overLimit = probeString(probe, expectedMax + 1);

      expect(atLimit).toHaveLength(expectedMax);
      expect(overLimit).toHaveLength(expectedMax + 1);
      expect(
        field.safeParse(atLimit).success,
        'MCP twin bound drifted from its REST counterpart, or stopped counting UTF-16 code units'
      ).toBe(true);
      expect(field.safeParse(overLimit).success, 'MCP twin accepted one unit over its bound').toBe(
        false
      );
    }
  );
});

describe('length limits: astral-character UTF-16 boundary (#626, ADR-088 — pins CURRENT unchanged behavior)', () => {
  it('ActorLabel: astral character at maxLength boundary is accepted, one UTF-16 unit over is rejected', () => {
    const atLimit = ASTRAL_CHAR.repeat(100); // 100 code points = 200 UTF-16 units
    const overLimit = `${atLimit}x`; // 201 UTF-16 units

    expect(atLimit).toHaveLength(200);
    expect(ActorLabelSchema.safeParse(atLimit).success).toBe(true);
    expect(overLimit).toHaveLength(201);
    expect(ActorLabelSchema.safeParse(overLimit).success).toBe(false);
  });

  it('StandardVerificationBody.notes: astral character at maxLength boundary is accepted, one UTF-16 unit over is rejected', () => {
    const atLimit = ASTRAL_CHAR.repeat(2500); // 2500 code points = 5000 UTF-16 units
    const overLimit = `${atLimit}x`; // 5001 UTF-16 units

    expect(atLimit).toHaveLength(5000);
    expect(VerificationBodySchema.shape.notes.safeParse(atLimit).success).toBe(true);
    expect(overLimit).toHaveLength(5001);
    expect(VerificationBodySchema.shape.notes.safeParse(overLimit).success).toBe(false);
  });

  it('POST /users label: astral character at maxLength boundary is accepted, one UTF-16 unit over is rejected', () => {
    const atLimit = ASTRAL_CHAR.repeat(100); // 100 code points = 200 UTF-16 units
    const overLimit = `${atLimit}x`; // 201 UTF-16 units

    expect(atLimit).toHaveLength(200);
    expect(ResolveUserBody.safeParse({ label: atLimit }).success).toBe(true);
    expect(overLimit).toHaveLength(201);
    expect(ResolveUserBody.safeParse({ label: overLimit }).success).toBe(false);
  });
});
