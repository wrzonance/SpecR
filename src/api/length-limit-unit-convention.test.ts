// src/api/length-limit-unit-convention.test.ts
//
// #626 (ADR-088) — Zod's `.max(n)` delegates to `String.prototype.length`
// (UTF-16 code units); JSON Schema's `maxLength` keyword (used by every
// `openapi.yaml` field it mirrors) is defined in Unicode code points. For
// any character outside the Basic Multilingual Plane the two counts diverge
// by up to 2x, so a spec-compliant client can construct a payload the
// documented contract says is valid but the server 422s. ADR-088 chose
// "accept and document" over changing enforcement: every published bound's
// `openapi.yaml` description states the UTF-16 convention verbatim
// (`UTF16_LENGTH_LIMIT_NOTE`).
//
// This file has two jobs. The MCP half of the same convention is gated
// separately in src/mcp/length-limit-unit-convention.test.ts.
//
// 1. Coverage sweep — walk the WHOLE spec and require every `maxLength` it
//    publishes to carry the note, rather than checking a hand-listed set of
//    sites. An enumerated list cannot fail for a bound nobody remembered to
//    add to it, which is the exact way this convention would rot: #626 calls
//    a partial fix worse than none.
// 2. Bound parity — for each documented bound, read `n` FROM THE SPEC and
//    prove the paired Zod validator accepts exactly `n` UTF-16 code units and
//    rejects `n + 1`. Nothing here hardcodes an expected number, so the test
//    fails if EITHER side drifts: an earlier revision compared the spec against
//    a hardcoded literal and a Zod bound silently dropping 200 -> 199 passed
//    the whole suite.
import { describe, it, expect } from 'vitest';
import { UTF16_LENGTH_LIMIT_NOTE } from '../lib/length-limit-note.js';
import { ActorLabelSchema, LanguageRulesWriteSchema } from '../ast/index.js';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
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

/** A string of exactly `units` UTF-16 code units, mostly astral characters. */
function astralOfLength(units: number): string {
  return ASTRAL_CHAR.repeat(Math.floor(units / 2)) + (units % 2 === 1 ? 'x' : '');
}

/** Same, but a syntactically valid URL (astral characters are legal in a path). */
function astralUrlOfLength(units: number): string {
  const prefix = 'https://example.com/';
  return prefix + astralOfLength(units - prefix.length);
}

// ── Spec-wide inventory ──────────────────────────────────────────────────────

interface SpecLengthField {
  readonly path: string;
  readonly maxLength: number;
  readonly description: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** This node's own `maxLength`, if it declares one. */
function ownSpecLengthField(node: Record<string, unknown>, path: string): SpecLengthField[] {
  const max = node['maxLength'];
  if (typeof max !== 'number') return [];
  const description = node['description'];
  return [
    { path, maxLength: max, description: typeof description === 'string' ? description : '' },
  ];
}

/**
 * Every `maxLength` anywhere in the document. Deliberately structure-agnostic:
 * it descends through every object value and array element rather than
 * following a known OpenAPI shape, so a bound introduced under a keyword this
 * test never anticipated is still found.
 */
function collectSpecLengthFields(node: unknown, path: string): SpecLengthField[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => collectSpecLengthFields(item, `${path}[${index}]`));
  }
  if (!isRecord(node)) return [];
  return [
    ...ownSpecLengthField(node, path),
    ...Object.entries(node).flatMap(([key, value]) =>
      collectSpecLengthFields(value, `${path}.${key}`)
    ),
  ];
}

/**
 * Bounds that legitimately carry no ADR-088 note, by exact path suffix.
 *
 * `sha256` is the only one. It is a fixed 64-character hex digest that the
 * server GENERATES and only ever returns (SpecLineage appears solely in the
 * getSpecLineage response — no request body accepts it), so no client can send
 * an astral payload into it and the two counting methods can never disagree
 * there. Contrast `imageData`, which looks ASCII-only but is validated as a
 * plain bounded string with no base64 pattern behind it, so it IS reachable and
 * is documented like every other bound rather than exempted.
 */
const UNDOCUMENTED_BOUND_EXEMPTIONS: readonly string[] = ['.sha256'];

const isExempt = (field: SpecLengthField): boolean =>
  UNDOCUMENTED_BOUND_EXEMPTIONS.some((suffix) => field.path.endsWith(suffix));

async function specLengthFields(): Promise<SpecLengthField[]> {
  return collectSpecLengthFields(await loadRawSpec(), 'openapi');
}

describe('openapi.yaml — every published maxLength documents the ADR-088 unit convention (#626)', () => {
  it('the spec publishes maxLength bounds at all (guards against a vacuous sweep)', async () => {
    expect(
      (await specLengthFields()).length,
      'no maxLength was found anywhere in openapi.yaml — the sweep below would pass vacuously, so ' +
        'this is a harness failure (spec loading or traversal broke), not a clean bill'
    ).toBeGreaterThan(5);
  });

  it('no bound is published without either the UTF-16 note or a documented exemption', async () => {
    const undocumented = (await specLengthFields())
      .filter((field) => !isExempt(field))
      .filter((field) => !field.description.includes(UTF16_LENGTH_LIMIT_NOTE))
      .map((field) => `${field.path} (maxLength: ${field.maxLength})`);

    expect(
      undocumented,
      'these openapi.yaml fields publish a maxLength — which JSON Schema defines in Unicode code ' +
        'points — while Zod enforces it in UTF-16 code units, and their description does not say ' +
        'so. Add UTF16_LENGTH_LIMIT_NOTE to the description, or, if the bound is genuinely ' +
        'unreachable by client-supplied astral text, add it to UNDOCUMENTED_BOUND_EXEMPTIONS with ' +
        'a justification'
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

// ── Bound parity: the spec's number is the number Zod actually enforces ──────

interface BoundSite {
  readonly name: string;
  /** Unique path suffix identifying this bound in the spec inventory. */
  readonly pathEndsWith: string;
  /** Does the paired Zod validator accept this string? */
  readonly accepts: (value: string) => boolean;
  readonly probe: (units: number) => string;
}

const succeeds =
  (parse: (value: string) => { success: boolean }) =>
  (value: string): boolean =>
    parse(value).success;

const BOUND_SITES: readonly BoundSite[] = [
  {
    name: 'POST /users label',
    pathEndsWith: '.properties.label',
    accepts: succeeds((value) => ResolveUserBody.safeParse({ label: value })),
    probe: astralOfLength,
  },
  {
    name: 'ActorLabel',
    pathEndsWith: 'components.schemas.ActorLabel',
    accepts: succeeds((value) => ActorLabelSchema.safeParse(value)),
    probe: astralOfLength,
  },
  {
    name: 'LanguageRuleTermWrite.term',
    pathEndsWith: '.properties.term',
    accepts: succeeds((value) =>
      LanguageRulesWriteSchema.safeParse({ bannedTerms: [{ term: value }] })
    ),
    probe: astralOfLength,
  },
  {
    name: 'StandardVerificationBody.currentVersion',
    pathEndsWith: 'StandardVerificationBody.properties.currentVersion',
    accepts: succeeds((value) => VerificationBodySchema.shape.currentVersion.safeParse(value)),
    probe: astralOfLength,
  },
  {
    name: 'StandardVerificationBody.sourceUrl',
    pathEndsWith: 'StandardVerificationBody.properties.sourceUrl',
    accepts: succeeds((value) => VerificationBodySchema.shape.sourceUrl.safeParse(value)),
    probe: astralUrlOfLength,
  },
  {
    name: 'StandardVerificationBody.title',
    pathEndsWith: 'StandardVerificationBody.properties.title',
    accepts: succeeds((value) => VerificationBodySchema.shape.title.safeParse(value)),
    probe: astralOfLength,
  },
  {
    name: 'StandardVerificationBody.notes',
    pathEndsWith: 'StandardVerificationBody.properties.notes',
    accepts: succeeds((value) => VerificationBodySchema.shape.notes.safeParse(value)),
    probe: astralOfLength,
  },
];

describe('openapi.yaml bounds match what Zod enforces, counted in UTF-16 code units (#626)', () => {
  it.each(BOUND_SITES)(
    '$name: the spec’s maxLength is exactly the Zod bound, and one UTF-16 unit over is rejected',
    async ({ pathEndsWith, accepts, probe }) => {
      const matches = (await specLengthFields()).filter((field) =>
        field.path.endsWith(pathEndsWith)
      );
      expect(
        matches.length,
        `expected exactly one openapi.yaml bound at a path ending "${pathEndsWith}" — ` +
          `found ${matches.length}. The site moved or the spec grew an ambiguous twin; fix the ` +
          'selector rather than loosening it, or this assertion silently stops covering the field'
      ).toBe(1);
      const declared = matches[0]?.maxLength ?? 0;

      const atLimit = probe(declared);
      const overLimit = probe(declared + 1);
      expect(atLimit).toHaveLength(declared);
      expect(overLimit).toHaveLength(declared + 1);

      expect(
        accepts(atLimit),
        'Zod rejected a payload of exactly the spec’s maxLength in UTF-16 code units — the ' +
          'enforced bound drifted below the documented one, so the contract now over-promises'
      ).toBe(true);
      expect(
        accepts(overLimit),
        'Zod accepted one UTF-16 code unit MORE than the spec’s maxLength — the enforced bound ' +
          'drifted above the documented one, or the check stopped counting UTF-16 units'
      ).toBe(false);
    }
  );

  // imageData's bound is ~7M characters; probing it behaviorally would allocate
  // two ~14 MB strings per run for no extra signal. Bind the published number to
  // the constant that defines it instead.
  it('imageData: every published bound equals MAX_IMAGE_BASE64_LENGTH', async () => {
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
// whether each twin's bound still MATCHES its REST counterpart and is still
// counted in UTF-16 units — a twin silently drifting to .max(199), or to a
// code-point check, would keep its note and pass there. That is this block's job.
// It matters because these two shapes do NOT reuse the REST validators: they
// re-declare their own `.max(n)` literals, so nothing but this test holds the two
// surfaces to the same number.
interface McpTwinSite {
  readonly name: string;
  readonly expectedMax: number;
  readonly field: { safeParse: (value: unknown) => { success: boolean } };
  readonly probe: (units: number) => string;
}

const MCP_TWIN_SITES: readonly McpTwinSite[] = [
  {
    name: 'resolve_user.label',
    expectedMax: 200,
    field: ResolveUserShape.label,
    probe: astralOfLength,
  },
  {
    name: 'record_standard_verification.currentVersion',
    expectedMax: 200,
    field: RecordStandardVerificationShape.currentVersion,
    probe: astralOfLength,
  },
  {
    name: 'record_standard_verification.sourceUrl',
    expectedMax: 2000,
    field: RecordStandardVerificationShape.sourceUrl,
    probe: astralUrlOfLength,
  },
  {
    name: 'record_standard_verification.title',
    expectedMax: 500,
    field: RecordStandardVerificationShape.title,
    probe: astralOfLength,
  },
  {
    name: 'record_standard_verification.notes',
    expectedMax: 5000,
    field: RecordStandardVerificationShape.notes,
    probe: astralOfLength,
  },
];

describe('MCP tool shapes — twin length bounds stay identical to their REST counterparts (#626)', () => {
  it.each(MCP_TWIN_SITES)(
    '$name: bound is $expectedMax UTF-16 code units, matching its REST twin',
    ({ expectedMax, field, probe }) => {
      const atLimit = probe(expectedMax);
      const overLimit = probe(expectedMax + 1);

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
