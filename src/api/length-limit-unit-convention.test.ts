// src/api/length-limit-unit-convention.test.ts
//
// #642 (ADR-091) — JSON Schema's `maxLength` keyword (used by every
// `openapi.yaml` field it mirrors) is defined in UNICODE CODE POINTS. This
// repo used to enforce these bounds in UTF-16 code units (#626/ADR-088,
// documented not fixed); codePointMax (src/lib/length-limit.ts) is now the
// single helper every bounded string field routes through, so the published
// number and the enforced one derive from one constant instead of drifting
// independently.
//
// This file has two jobs. The MCP half of the same convention is gated
// separately in src/mcp/length-limit-unit-convention.test.ts.
//
// 1. Coverage sweep — walk the WHOLE spec and require every `maxLength` it
//    publishes to carry NO stale UTF-16 note (the old #626 convention this
//    change retires), rather than checking a hand-listed set of sites.
// 2. Bound parity — for each documented bound, prove: the spec's declared
//    maxLength === the imported TS constant that defines it === the boundary
//    Zod actually enforces, counted in UNICODE CODE POINTS (a NON-BMP probe,
//    not a UTF-16-unit one) === the Zod field's generated schema carries the
//    x-length-unit marker. Comparing against an IMPORTED CONSTANT (not a
//    hardcoded literal) is deliberate: PR #637 shipped a version of this
//    gate that compared openapi.yaml against a hardcoded number, so a Zod
//    bound could drift 200->199 with nothing to catch it. Importing the same
//    constant the schema is built from closes that hole.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ActorLabelSchema,
  LanguageRulesWriteSchema,
  MAX_LITERAL_TERM_LENGTH,
} from '../ast/index.js';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import { MAX_LABEL_LENGTH } from '../lib/label-length.js';
import {
  MAX_CURRENT_VERSION_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_NOTES_LENGTH,
} from '../lib/standards-verification-length.js';
import { LENGTH_UNIT_META_KEY, CODE_POINT_LENGTH_UNIT } from '../lib/length-limit.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';
import { collectLengthFields, type LengthField } from '../test-utils/contract/length-fields.js';
import { VerificationBodySchema } from './standards.js';
import { ResolveUserBody } from './users.js';
import { ResolveUserShape } from '../mcp/users-handlers.js';
import { RecordStandardVerificationShape } from '../mcp/standards-handlers.js';

// A non-BMP character: U+1F600 GRINNING FACE, 1 Unicode code point, 2 UTF-16
// code units (a surrogate pair). Repeating it N times yields a string whose
// `[...str].length` (code points) is N and whose `.length` (UTF-16 units) is
// 2N — the exact divergence ADR-091 fixes. Probing with THIS character
// (never a plain ASCII one) is what makes these assertions fail if enforcement
// ever regresses back to counting UTF-16 units.
const ASTRAL_CHAR = '\u{1F600}';

/** A string of exactly `codePoints` Unicode code points, all astral. */
function astralOfCodePointLength(codePoints: number): string {
  return ASTRAL_CHAR.repeat(codePoints);
}

/** Same, but a syntactically valid URL (astral characters are legal in a path). */
function astralUrlOfCodePointLength(codePoints: number): string {
  const prefix = 'https://example.com/';
  return prefix + astralOfCodePointLength(codePoints - [...prefix].length);
}

// ── Spec-wide inventory ──────────────────────────────────────────────────────

/**
 * Bounds that legitimately carry no published bound, by exact path suffix.
 *
 * `sha256` is the only one. It is a fixed 64-character hex digest that the
 * server GENERATES and only ever returns (SpecLineage appears solely in the
 * getSpecLineage response — no request body accepts it), so no client can send
 * an astral payload into it and the two counting methods can never disagree
 * there. Contrast `imageData`, which looks ASCII-only but is validated as a
 * plain bounded string with no base64 pattern behind it, so it IS reachable and
 * is bounded like every other field rather than exempted.
 */
const UNDOCUMENTED_BOUND_EXEMPTIONS: readonly string[] = ['.sha256'];

const isExempt = (field: LengthField): boolean =>
  UNDOCUMENTED_BOUND_EXEMPTIONS.some((suffix) => field.path.endsWith(suffix));

async function specLengthFields(): Promise<LengthField[]> {
  return collectLengthFields(await loadRawSpec(), 'openapi');
}

// The prose sentence #626/ADR-088 required and #642/ADR-091 retires. A stale
// copy left behind on any site would (wrongly) tell a reader the server still
// diverges from the published contract.
const STALE_UTF16_NOTE_FRAGMENT = 'UTF-16 code units';

describe('openapi.yaml — no field claims a UTF-16/code-point divergence that no longer exists (#642)', () => {
  it('the spec publishes maxLength bounds at all (guards against a vacuous sweep)', async () => {
    expect(
      (await specLengthFields()).length,
      'no maxLength was found anywhere in openapi.yaml — the sweep below would pass vacuously, so ' +
        'this is a harness failure (spec loading or traversal broke), not a clean bill'
    ).toBeGreaterThan(5);
  });

  it('no published bound describes itself as UTF-16-code-unit-counted', async () => {
    const stale = (await specLengthFields())
      .filter((field) => field.description.includes(STALE_UTF16_NOTE_FRAGMENT))
      .map((field) => `${field.path} (maxLength: ${field.maxLength})`);

    expect(
      stale,
      'these openapi.yaml fields still claim a UTF-16-vs-code-point divergence (ADR-088) that ' +
        'ADR-091 fixed by enforcing code points directly — remove the stale sentence from the ' +
        'description'
    ).toEqual([]);
  });

  it('the sha256 exemption is still a fixed-length server-generated digest, not a drifting bound', async () => {
    const exempt = (await specLengthFields()).filter(isExempt);
    expect(exempt.length, 'expected exactly one exempted bound (sha256)').toBe(1);
    expect(
      exempt[0]?.maxLength,
      'sha256 is exempt because it is a fixed 64-character hex digest; a different bound means the ' +
        'field changed shape and the exemption must be re-justified'
    ).toBe(64);
  });
});

// ── Bound parity: spec === imported constant === Zod enforcement === marker ──

/** Every `maxLength` a Zod field publishes on its own generated schema, walking through any `.optional()`/`.nullish()` wrap. */
function fieldLengthFields(schema: z.ZodType): LengthField[] {
  const generated = z.toJSONSchema(schema, { io: 'input' });
  return collectLengthFields(generated, 'field');
}

function carriesCodePointMarker(schema: z.ZodType): boolean {
  return fieldLengthFields(schema).some(
    (field) => field.node[LENGTH_UNIT_META_KEY] === CODE_POINT_LENGTH_UNIT
  );
}

interface BoundSite {
  readonly name: string;
  /** Unique path suffix identifying this bound in the spec inventory. */
  readonly pathEndsWith: string;
  readonly max: number;
  /** Does the paired Zod validator accept this string? */
  readonly accepts: (value: string) => boolean;
  /** The Zod field itself, for asserting the code-point-unit marker. Omitted only for LanguageRuleTermWrite.term, whose bound is an object-level `.check()`, not a field-level codePointMax (see ADR-091). */
  readonly field?: z.ZodType;
  readonly probe: (codePoints: number) => string;
}

const succeeds =
  (parse: (value: string) => { success: boolean }) =>
  (value: string): boolean =>
    parse(value).success;

const BOUND_SITES: readonly BoundSite[] = [
  {
    name: 'POST /users label',
    pathEndsWith: '.properties.label',
    max: MAX_LABEL_LENGTH,
    accepts: succeeds((value) => ResolveUserBody.safeParse({ label: value })),
    field: ResolveUserBody.shape.label,
    probe: astralOfCodePointLength,
  },
  {
    name: 'ActorLabel',
    pathEndsWith: 'components.schemas.ActorLabel',
    max: MAX_LABEL_LENGTH,
    accepts: succeeds((value) => ActorLabelSchema.safeParse(value)),
    field: ActorLabelSchema,
    probe: astralOfCodePointLength,
  },
  {
    name: 'LanguageRuleTermWrite.term',
    pathEndsWith: '.properties.term',
    max: MAX_LITERAL_TERM_LENGTH, // object-level check, not field-level codePointMax; see `field` doc above
    accepts: succeeds((value) =>
      LanguageRulesWriteSchema.safeParse({ bannedTerms: [{ term: value }] })
    ),
    probe: astralOfCodePointLength,
  },
  {
    name: 'StandardVerificationBody.currentVersion',
    pathEndsWith: 'StandardVerificationBody.properties.currentVersion',
    max: MAX_CURRENT_VERSION_LENGTH,
    accepts: succeeds((value) => VerificationBodySchema.shape.currentVersion.safeParse(value)),
    field: VerificationBodySchema.shape.currentVersion,
    probe: astralOfCodePointLength,
  },
  {
    name: 'StandardVerificationBody.sourceUrl',
    pathEndsWith: 'StandardVerificationBody.properties.sourceUrl',
    max: MAX_SOURCE_URL_LENGTH,
    accepts: succeeds((value) => VerificationBodySchema.shape.sourceUrl.safeParse(value)),
    field: VerificationBodySchema.shape.sourceUrl,
    probe: astralUrlOfCodePointLength,
  },
  {
    name: 'StandardVerificationBody.title',
    pathEndsWith: 'StandardVerificationBody.properties.title',
    max: MAX_TITLE_LENGTH,
    accepts: succeeds((value) => VerificationBodySchema.shape.title.safeParse(value)),
    field: VerificationBodySchema.shape.title,
    probe: astralOfCodePointLength,
  },
  {
    name: 'StandardVerificationBody.notes',
    pathEndsWith: 'StandardVerificationBody.properties.notes',
    max: MAX_NOTES_LENGTH,
    accepts: succeeds((value) => VerificationBodySchema.shape.notes.safeParse(value)),
    field: VerificationBodySchema.shape.notes,
    probe: astralOfCodePointLength,
  },
];

describe('openapi.yaml bounds match the imported constant and what Zod enforces, in Unicode code points (#642)', () => {
  it.each(BOUND_SITES)(
    '$name: spec maxLength === imported constant === Zod boundary (code points), one over is rejected',
    async ({ pathEndsWith, max, accepts, field, probe }) => {
      const matches = (await specLengthFields()).filter((f) => f.path.endsWith(pathEndsWith));
      expect(
        matches.length,
        `expected exactly one openapi.yaml bound at a path ending "${pathEndsWith}" — ` +
          `found ${matches.length}. The site moved or the spec grew an ambiguous twin; fix the ` +
          'selector rather than loosening it, or this assertion silently stops covering the field'
      ).toBe(1);
      const declared = matches[0]?.maxLength ?? 0;

      expect(
        declared,
        'openapi.yaml maxLength drifted from the imported TS constant that is supposed to define it'
      ).toBe(max);

      const atLimit = probe(declared);
      const overLimit = probe(declared + 1);
      expect([...atLimit]).toHaveLength(declared);
      expect([...overLimit]).toHaveLength(declared + 1);

      expect(
        accepts(atLimit),
        'Zod rejected a payload of exactly the spec’s maxLength in Unicode code points — the ' +
          'enforced bound drifted below the documented one, so the contract now over-promises'
      ).toBe(true);
      expect(
        accepts(overLimit),
        'Zod accepted one Unicode code point MORE than the spec’s maxLength — the enforced bound ' +
          'drifted above the documented one, or the check stopped counting code points'
      ).toBe(false);

      if (field !== undefined) {
        expect(
          carriesCodePointMarker(field),
          `${pathEndsWith}'s Zod field does not carry the x-length-unit: unicode-code-point ` +
            'marker — it was not built via codePointMax (src/lib/length-limit.ts)'
        ).toBe(true);
      }
    }
  );

  // imageData's bound is ~7M characters; probing it behaviorally would allocate
  // two ~14 MB strings per run for no extra signal. Bind the published number to
  // the constant that defines it instead.
  it('imageData: every published bound equals MAX_IMAGE_BASE64_LENGTH and carries the code-point marker', async () => {
    const imageBounds = (await specLengthFields()).filter((field) =>
      field.path.endsWith('.imageData')
    );
    expect(imageBounds.length, 'expected at least one imageData bound in the spec').toBeGreaterThan(
      0
    );
    for (const field of imageBounds) {
      expect(field.maxLength, `${field.path} drifted from MAX_IMAGE_BASE64_LENGTH`).toBe(
        MAX_IMAGE_BASE64_LENGTH
      );
    }
  });
});

// ── MCP twins ───────────────────────────────────────────────────────────────

// Note-presence across the WHOLE MCP surface is asserted by the invariant sweep
// in src/mcp/length-limit-unit-convention.test.ts. What that sweep cannot see is
// whether each twin's bound still MATCHES its REST counterpart, is counted in
// Unicode code points, and carries the marker — a twin silently drifting to
// .max(199), or back to a UTF-16-unit check, would keep publishing SOME
// maxLength and pass there. That is this block's job. It matters because these
// two shapes do NOT reuse the REST validators: they import the same numeric
// constant but build their own codePointMax call, so nothing but this test
// holds the two surfaces to the same enforced behavior.
interface McpTwinSite {
  readonly name: string;
  readonly expectedMax: number;
  readonly field: z.ZodType;
  readonly probe: (codePoints: number) => string;
}

const MCP_TWIN_SITES: readonly McpTwinSite[] = [
  {
    name: 'resolve_user.label',
    expectedMax: MAX_LABEL_LENGTH,
    field: ResolveUserShape.label,
    probe: astralOfCodePointLength,
  },
  {
    name: 'record_standard_verification.currentVersion',
    expectedMax: MAX_CURRENT_VERSION_LENGTH,
    field: RecordStandardVerificationShape.currentVersion,
    probe: astralOfCodePointLength,
  },
  {
    name: 'record_standard_verification.sourceUrl',
    expectedMax: MAX_SOURCE_URL_LENGTH,
    field: RecordStandardVerificationShape.sourceUrl,
    probe: astralUrlOfCodePointLength,
  },
  {
    name: 'record_standard_verification.title',
    expectedMax: MAX_TITLE_LENGTH,
    field: RecordStandardVerificationShape.title,
    probe: astralOfCodePointLength,
  },
  {
    name: 'record_standard_verification.notes',
    expectedMax: MAX_NOTES_LENGTH,
    field: RecordStandardVerificationShape.notes,
    probe: astralOfCodePointLength,
  },
];

describe('MCP tool shapes — twin length bounds stay identical to their REST counterparts, in code points (#642)', () => {
  it.each(MCP_TWIN_SITES)(
    '$name: bound is $expectedMax Unicode code points, matching its REST twin, and carries the marker',
    ({ name, expectedMax, field, probe }) => {
      const atLimit = probe(expectedMax);
      const overLimit = probe(expectedMax + 1);

      expect([...atLimit]).toHaveLength(expectedMax);
      expect([...overLimit]).toHaveLength(expectedMax + 1);
      expect(
        field.safeParse(atLimit).success,
        'MCP twin bound drifted from its REST counterpart, or stopped counting Unicode code points'
      ).toBe(true);
      expect(
        field.safeParse(overLimit).success,
        'MCP twin accepted one code point over its bound'
      ).toBe(false);
      expect(
        carriesCodePointMarker(field),
        `${name} does not carry the x-length-unit: unicode-code-point marker — it was not built ` +
          'via codePointMax (src/lib/length-limit.ts)'
      ).toBe(true);
    }
  );
});
