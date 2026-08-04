import { describe, it, expect } from 'vitest';
import {
  assertResponse,
  assertResponseExact,
  specOperationManifest,
  successJsonOps,
  loadSpec,
  loadRawSpec,
  operationParamKeys,
  markUnevaluatedPropertiesFalse,
  buildMirrorQualifyRef,
  resolveResponseSchema,
  getValidator,
} from './validate-response.js';
import type { OpenApiDoc } from './validate-response.js';

// A fixed-format UUID literal — ajv's `format: uuid` only checks shape, so every synthetic
// SpecNode below reuses this rather than pulling in a real uuid generator.
const NODE_ID = '11111111-1111-1111-1111-111111111111';

/** Builds a `depth`-deep, self-referential SpecNode chain (`children: [child]` at every level) —
 * the exact shape that made $RefParser.dereference() build a literal circular JS object and blow
 * ajv's compile-time traversal stack before #649. */
function buildDeepSpecNode(depth: number): unknown {
  let node: unknown = { id: NODE_ID, type: 'pr1', text: 'leaf', children: [], meta: {} };
  for (let i = 0; i < depth; i++) {
    node = { id: NODE_ID, type: 'pr1', text: `depth-${i}`, children: [node], meta: {} };
  }
  return node;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// Narrow shape for the raw (un-dereferenced) request-body schema a #377 write op documents.
interface RawRequestBodySchema {
  properties?: Record<string, unknown>;
  required?: string[];
}
interface RawOperation {
  requestBody?: {
    required?: boolean;
    content: { 'application/json': { schema: RawRequestBodySchema } };
  };
  responses: Record<string, unknown>;
}
interface RawPaths {
  paths: Record<string, Partial<Record<'get' | 'post' | 'put' | 'patch' | 'delete', RawOperation>>>;
  components: {
    schemas: Record<string, RawRequestBodySchema & { additionalProperties?: boolean }>;
  };
}

describe('contract validate-response helper', () => {
  it('accepts a body that matches the documented schema', async () => {
    const body = { success: true, data: { db: 'connected', uptime: 5 } };
    await expect(assertResponse('get', '/health', 200, body)).resolves.toBeUndefined();
  });

  it('rejects a body that violates the documented schema', async () => {
    const body = { success: true }; // missing required `data`
    await expect(assertResponse('get', '/health', 200, body)).rejects.toThrow(/does not match/);
  });

  it('no-ops for a DOCUMENTED response that has no JSON schema', async () => {
    // DELETE /templates/{id} documents 204 with no content at all
    await expect(
      assertResponse('delete', '/templates/{id}', 204, undefined)
    ).resolves.toBeUndefined();
  });

  it('rejects a status the operation does not document, instead of passing vacuously', async () => {
    // DELETE /specs/{id}/lock documents 200 (not 204). Treating an undocumented status as a
    // "no JSON schema" no-op would validate nothing and stay green forever.
    await expect(assertResponse('delete', '/specs/{id}/lock', 204, undefined)).rejects.toThrow(
      /documents no 204 response/
    );
  });

  it('normalizes path params to {} so manifests are param-name agnostic', async () => {
    const doc = await loadSpec();
    expect(specOperationManifest(doc)).toContain('get /specs/{}');
    expect(successJsonOps(doc)).toContain('get /health');
  });
});

// #640 — assertResponse's schema-CONFORMANCE check lets an undocumented extra key pass silently
// (the vacuous-gate hole delete_package's stray `deleted` field exploited). assertResponseExact
// closes it via a structuredClone'd + `unevaluatedProperties: false`-augmented schema, compiled
// through a FRESH ajv instance rather than getValidator()'s shared WeakMap. /health is the
// worked example because its response is allOf-composed (SuccessResponse + an inline object) —
// exactly the shape whose walker had to mark only the allOf-OWNING node, never a branch.
describe('assertResponseExact (#640) — exact-key-match against openapi.yaml', () => {
  const validHealthBody = { success: true, data: { db: 'connected', uptime: 5 } };

  it('accepts a fully-conformant body — zero false positives on the documented shape', async () => {
    await expect(
      assertResponseExact('get', '/health', 200, validHealthBody)
    ).resolves.toBeUndefined();
  });

  it('rejects a top-level key the allOf-composed schema does not document', async () => {
    const body = { ...validHealthBody, extra: 'nope' };
    await expect(assertResponseExact('get', '/health', 200, body)).rejects.toThrow(
      /does not document/
    );
  });

  it('rejects a key nested under `data` that the schema does not document', async () => {
    const body = { success: true, data: { ...validHealthBody.data, extra: 'nope' } };
    await expect(assertResponseExact('get', '/health', 200, body)).rejects.toThrow(
      /does not document/
    );
  });

  it("shares resolveResponseSchema's contract with assertResponse: undocumented status fails loud, documented non-JSON no-ops", async () => {
    await expect(assertResponseExact('delete', '/specs/{id}/lock', 204, undefined)).rejects.toThrow(
      /documents no 204 response/
    );
    await expect(
      assertResponseExact('delete', '/templates/{id}', 204, undefined)
    ).resolves.toBeUndefined();
  });

  // Pipeline-level smoke check: it only has teeth alongside the dedicated no-mutation unit test
  // below, because getValidator()'s WeakMap for this op's schema is already warmed by the
  // 'accepts a fully-conformant body' test above (same describe block, runs first) — so a
  // regression that made assertResponseExact mutate the shared schema in place would compile a
  // corrupted validator into a FRESH cache slot instead, which this stale-cache read can't see.
  // The behavior itself is still real and worth pinning; `markUnevaluatedPropertiesFalse never
  // mutates its input schema` below is what actually proves the no-mutation invariant.
  it('never mutates or caches through the shared ajv WeakMap — assertResponse stays permissive on the same op afterward', async () => {
    const bodyWithExtra = { ...validHealthBody, extra: 'nope' };
    // The exact variant rejects the extra key...
    await expect(assertResponseExact('get', '/health', 200, bodyWithExtra)).rejects.toThrow();
    // ...but assertResponse — reading the SAME operation's schema through getValidator()'s shared
    // cache — must still accept it.
    await expect(assertResponse('get', '/health', 200, bodyWithExtra)).resolves.toBeUndefined();
  });

  it('assertResponse behavior is unchanged: still permissive of undocumented extra keys', async () => {
    const bodyWithExtra = { ...validHealthBody, extra: 'nope' };
    await expect(assertResponse('get', '/health', 200, bodyWithExtra)).resolves.toBeUndefined();
  });

  // Proves the no-mutation invariant directly against markUnevaluatedPropertiesFalse's own input,
  // independent of any ajv WeakMap cache-warmth ordering (unlike the pipeline check above, this
  // fails deterministically for a regression that reintroduces in-place mutation, regardless of
  // test execution order or which ops earlier tests happened to warm).
  it('markUnevaluatedPropertiesFalse never mutates its input schema', () => {
    const original = {
      type: 'object',
      properties: {
        keep: { type: 'string' },
        nested: { type: 'object', properties: { inner: { type: 'string' } } },
      },
    };
    const snapshot = structuredClone(original);

    const marked = markUnevaluatedPropertiesFalse(original) as {
      unevaluatedProperties?: boolean;
      properties: { nested: { unevaluatedProperties?: boolean } };
    };

    expect(original).toEqual(snapshot); // input object graph is byte-for-byte untouched
    expect(marked).not.toBe(original); // caller always gets an independent clone
    expect(marked.unevaluatedProperties).toBe(false);
    expect(marked.properties.nested.unevaluatedProperties).toBe(false);
  });

  // Pins the walker's SHARED-OBJECT-IDENTITY cycle guard (SeenContexts in unevaluated-properties.ts)
  // — a mechanism orthogonal to, and unaffected by, #649's switch from dereference to bundle. It has
  // nothing to do with `$ref` strings: it's a hand-built schema where ONE JS object (`shared`) is
  // literally reused at two composition sites in the SAME tree, the way any hand-authored or
  // programmatically-assembled schema legitimately can (bundling doesn't produce this shape — a
  // bundled `$ref` is a small, non-shared literal pointer object, handled separately by the
  // `qualifyRef`-rewrite tests below). Reached once as a raw allOf branch (must stay unmarked — see
  // unevaluated-properties.ts's applicator classification) and once nested under a sibling's
  // properties (must be marked). A visited-Set that only tracks "already seen" — not "seen under
  // which context" — lets whichever context visits first silently decide for both, dropping the
  // second context's mark.
  it('marks a schema reached via two different composition contexts independently, not first-visit-wins', () => {
    const shared = { type: 'object', properties: { name: { type: 'string' } } };
    const schema = {
      oneOf: [
        { type: 'object', allOf: [shared] },
        { type: 'object', properties: { wrapped: shared } },
      ],
    };

    const marked = markUnevaluatedPropertiesFalse(schema) as {
      oneOf: [
        { allOf: [{ unevaluatedProperties?: boolean }] },
        { properties: { wrapped: { unevaluatedProperties?: boolean } } },
      ];
    };
    const viaAllOf = marked.oneOf[0].allOf[0];
    const viaProperties = marked.oneOf[1].properties.wrapped;

    expect(viaAllOf.unevaluatedProperties).toBeUndefined(); // allOf branch: never marked directly
    expect(viaProperties.unevaluatedProperties).toBe(false); // reached via properties: marked
    expect(viaAllOf).not.toBe(viaProperties); // divergent contexts get independent clones
  });

  // Same shared-node-two-contexts shape as above, but with the branch order REVERSED: the
  // properties-context (marked) visit happens FIRST and the allOf-context (never-marked) visit
  // happens SECOND. A divergent-context clone taken from the shared node AFTER its first visit
  // already mutated that node leaks the first visit's mark onto the second visit's clone — the
  // allOf branch would come back marked, which is exactly the "allOf branch gets marked
  // directly" defect this whole walker exists to prevent. The prior test's branch order can't
  // catch this: it visits the allOf (unmarked) context first, so there is nothing yet to leak.
  it('marks a schema reached via two different composition contexts independently — properties-first branch order', () => {
    const shared = { type: 'object', properties: { name: { type: 'string' } } };
    const schema = {
      oneOf: [
        { type: 'object', properties: { wrapped: shared } },
        { type: 'object', allOf: [shared] },
      ],
    };

    const marked = markUnevaluatedPropertiesFalse(schema) as {
      oneOf: [
        { properties: { wrapped: { unevaluatedProperties?: boolean } } },
        { allOf: [{ unevaluatedProperties?: boolean }] },
      ];
    };
    const viaProperties = marked.oneOf[0].properties.wrapped;
    const viaAllOf = marked.oneOf[1].allOf[0];

    expect(viaProperties.unevaluatedProperties).toBe(false); // reached via properties: marked
    expect(viaAllOf.unevaluatedProperties).toBeUndefined(); // allOf branch: never marked directly
    expect(viaAllOf).not.toBe(viaProperties); // divergent contexts get independent clones
  });
});

// #649 — loadSpec() switched from $RefParser.dereference to .bundle so ajv can compile the
// self-referential SpecNode/SpecTree response schemas six operations' success bodies embed
// (previously a real circular JS object blew ajv's compile-time traversal stack). These pin the
// mechanism directly: a bundled `$ref` is a literal pointer object, never inlined, and
// markUnevaluatedPropertiesFalse's new `qualifyRef`/`inPlace` option rewrites it per LOCAL context.
describe('markUnevaluatedPropertiesFalse — $ref qualification (#649)', () => {
  it('rewrites a $ref via the qualifyRef callback and leaves the pointer node itself unmarked', () => {
    const schema = { properties: { child: { $ref: '#/components/schemas/Foo' } } };
    const marked = markUnevaluatedPropertiesFalse(schema, {
      qualifyRef: (ref, inPlace) => `${inPlace ? 'in' : 'child'}:${ref}`,
    }) as { properties: { child: { $ref: string; unevaluatedProperties?: boolean } } };
    expect(marked.properties.child.$ref).toBe('child:#/components/schemas/Foo');
    // A $ref-only node evaluates no properties of its own — marking it directly would be a false
    // positive (it isn't the node that actually owns the properties it points at).
    expect(marked.properties.child.unevaluatedProperties).toBeUndefined();
  });

  it('defaults qualifyRef to identity, matching every pre-#649 call site byte-for-byte', () => {
    const schema = { properties: { child: { $ref: '#/x' } } };
    const marked = markUnevaluatedPropertiesFalse(schema) as {
      properties: { child: { $ref: string } };
    };
    expect(marked.properties.child.$ref).toBe('#/x');
  });

  // The sharpest correctness pitfall the dual-mirror design found (see the PR description): a
  // CHILD-context keyword's `$ref` must be qualified with CHILD context even when the keyword
  // itself sits inside an allOf branch being walked under IN_PLACE context — `walkSubschemas`
  // hardcodes each keyword's context by category, never by the caller's own context, and this is
  // what makes that true. Getting it backwards would let an unqualified/mis-qualified ref
  // accidentally self-resolve against the WRONG mirror document by URI-shape coincidence rather
  // than failing loudly (confirmed during implementation: this exact mutation didn't fail against
  // real openapi.yaml schemas by coincidence, which is why this hand-built, ref-parser-independent
  // case exists — a real-spec-driven test can pass by accident where a hand-built one can't).
  it("qualifies a $ref inside `items` nested in an allOf branch using CHILD context, never leaking the branch's own IN_PLACE context", () => {
    const contexts: boolean[] = [];
    const qualifyRef = (ref: string, inPlace: boolean): string => {
      contexts.push(inPlace);
      return `${inPlace ? 'IN_PLACE' : 'CHILD'}:${ref}`;
    };
    const schema = {
      allOf: [
        {
          type: 'object',
          properties: {
            list: { type: 'array', items: { $ref: '#/components/schemas/Foo' } },
          },
        },
      ],
    };
    const marked = markUnevaluatedPropertiesFalse(schema, { qualifyRef }) as {
      allOf: [{ properties: { list: { items: { $ref: string } } } }];
    };
    expect(marked.allOf[0].properties.list.items.$ref).toBe('CHILD:#/components/schemas/Foo');
    expect(contexts).toEqual([false]); // never called with inPlace:true despite the allOf branch
  });

  it('buildMirrorQualifyRef throws on a non-local $ref instead of silently mis-qualifying it', () => {
    expect(() =>
      markUnevaluatedPropertiesFalse(
        { properties: { child: { $ref: 'https://example.com/foo' } } },
        { qualifyRef: buildMirrorQualifyRef() }
      )
    ).toThrow(/unsupported non-local/);
  });
});

// The core bug this issue fixes, pinned directly: loadSpec()'s bundled document + getValidator's
// $ref-qualification must compile and validate a genuinely self-referential SpecNode payload with
// zero RangeError — no DB, no HTTP, just the compiled ajv validator against the real openapi.yaml.
describe('#649: self-referential SpecNode/SpecTree schemas compile and validate', () => {
  it('getValidator compiles POST /specs/{id}/paragraphs’s 201 schema and validates a 200-deep synthetic SpecNode without RangeError', async () => {
    const doc = await loadSpec();
    const schema = resolveResponseSchema(doc, 'post', '/specs/{id}/paragraphs', 201);
    if (schema === undefined) throw new Error('expected a documented application/json schema');
    const validate = getValidator(schema);
    const body = { success: true, data: buildDeepSpecNode(200) };
    expect(() => validate(body)).not.toThrow();
    expect(validate(body)).toBe(true);
  });

  it.each([
    ['get', '/specs/{id}', 200] as const,
    ['post', '/specs/{id}/paragraphs', 201] as const,
    ['patch', '/specs/{id}/paragraphs/{nodeId}', 200] as const,
    ['patch', '/specs/{id}/paragraphs/{nodeId}/removal', 200] as const,
    ['patch', '/specs/{id}/paragraphs/{nodeId}/reject', 200] as const,
    ['get', '/revisions/{id}', 200] as const,
  ])(
    'the six previously-unvalidated operations (%s %s) each compile via getValidator',
    async (method, path, status) => {
      const doc = await loadSpec();
      const schema = resolveResponseSchema(doc, method, path, status);
      if (schema === undefined) throw new Error('expected a documented application/json schema');
      expect(() => getValidator(schema)).not.toThrow();
    }
  );

  // The false-rejection pitfall the dual-mirror design exists to avoid: SuccessResponse is an
  // allOf-envelope branch for EVERY response, so a single "mark every component once, standalone"
  // mirror makes IN_PLACE_MIRROR's SuccessResponse entry ALSO carry `unevaluatedProperties: false`
  // — and a standalone SuccessResponse only "sees" its own `success` key, never a sibling allOf
  // branch's `data` key, so it would reject a fully clean, fully-documented payload. Driving a real
  // op's exact-match check against a genuinely clean body proves the two-mirror split avoids this.
  it('assertResponseExact accepts a clean SuccessResponse-enveloped SpecNode payload (no false rejection)', async () => {
    const body = {
      success: true,
      data: { id: NODE_ID, type: 'pr1', text: 'clean', children: [], meta: {} },
    };
    await expect(
      assertResponseExact('patch', '/specs/{id}/paragraphs/{nodeId}', 200, body)
    ).resolves.toBeUndefined();
  });

  it('assertResponseExact rejects an undocumented key nested inside SpecNode.children, not just at the top level', async () => {
    const body = {
      success: true,
      data: {
        id: NODE_ID,
        type: 'pr1',
        text: 'parent',
        children: [{ id: NODE_ID, type: 'pr2', text: 'child', children: [], meta: {}, rogue: 1 }],
        meta: {},
      },
    };
    await expect(
      assertResponseExact('patch', '/specs/{id}/paragraphs/{nodeId}', 200, body)
    ).rejects.toThrow(/does not document/);
  });
});

// #640 adversarial-review follow-ups. The walker's job is to make the gate strict WITHOUT making it
// wrong: a vacuous branch lets an undocumented key through silently (the bug #640 exists to kill),
// while a false positive rejects a fully-documented payload and gets the gate weakened or reverted.
// Each case below is one applicator shape that used to fail one of those two ways.
describe('markUnevaluatedPropertiesFalse — JSON-Schema 2020-12 applicator coverage (#640)', () => {
  function validator(schema: object): (body: unknown) => boolean {
    return getValidator(markUnevaluatedPropertiesFalse(schema)) as (body: unknown) => boolean;
  }

  // `unevaluatedProperties` on a oneOf/anyOf BRANCH is evaluated standalone against the whole
  // instance, so it cannot see keys the branch's PARENT evaluates — marking branches rejected
  // `{ common, a }` here. Only the composition OWNER may be marked; it unions its own `properties`
  // annotations with the successful branch's.
  it('accepts a payload split across a composition owner and its oneOf branch, and still rejects extras', () => {
    const validate = validator({
      type: 'object',
      properties: { common: { type: 'string' } },
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    });
    expect(validate({ common: 'x', a: 'y' })).toBe(true); // no false positive
    expect(validate({ common: 'x', a: 'y', rogue: 1 })).toBe(false); // still exact
  });

  // anyOf combines the annotations of EVERY successful branch — the "exactly one branch applies"
  // assumption that justified marking branches is simply false here.
  it('combines annotations across all successful anyOf branches', () => {
    const validate = validator({
      type: 'object',
      anyOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }],
    });
    expect(validate({ a: 'x', b: 'y' })).toBe(true);
    expect(validate({ a: 'x', rogue: 1 })).toBe(false);
  });

  // Objects reachable only through these keywords were never walked, so every key inside them was
  // undocumented-but-accepted — a vacuous gate at exactly the nesting depth #640 cares about.
  it.each([
    {
      keyword: 'patternProperties',
      schema: {
        type: 'object',
        patternProperties: { '^x-': { type: 'object', properties: { known: { type: 'string' } } } },
      },
      valid: { 'x-one': { known: 'v' } },
      extra: { 'x-one': { known: 'v', rogue: 1 } },
    },
    {
      keyword: 'additionalProperties (schema-valued)',
      schema: {
        type: 'object',
        additionalProperties: { type: 'object', properties: { known: { type: 'string' } } },
      },
      valid: { any: { known: 'v' } },
      extra: { any: { known: 'v', rogue: 1 } },
    },
    {
      // #649: `items` is the CHILD_SINGLES entry that actually matters most — it's what recurses
      // into SpecNode's own `children: SpecNode[]` array — yet no case here exercised it directly
      // (only its cousins prefixItems/contains/unevaluatedItems were covered), so the issue's
      // mandated mutation-verify bar ("remove one entry from CHILD_SINGLES, confirm the pinning
      // test goes red") had nothing to go red for `items` specifically.
      keyword: 'items',
      schema: {
        type: 'array',
        items: { type: 'object', properties: { a: { type: 'string' } } },
      },
      valid: [{ a: 'x' }],
      extra: [{ a: 'x', rogue: 1 }],
    },
    {
      keyword: 'prefixItems',
      schema: {
        type: 'array',
        prefixItems: [{ type: 'object', properties: { a: { type: 'string' } } }],
      },
      valid: [{ a: 'x' }],
      extra: [{ a: 'x', rogue: 1 }],
    },
    {
      keyword: 'contains',
      schema: {
        type: 'array',
        contains: { type: 'object', properties: { a: { type: 'string' } } },
      },
      valid: [{ a: 'x' }],
      extra: [{ a: 'x', rogue: 1 }],
    },
    {
      // CodeRabbit #645: `unevaluatedItems` is the 2020-12 Unevaluated-vocabulary sibling of
      // `items`/`contains` — an object subschema under it evaluates properties, so omitting it
      // from the walker let an undocumented key inside an array item pass the exact gate.
      keyword: 'unevaluatedItems (schema-valued)',
      schema: {
        type: 'array',
        prefixItems: [{ type: 'string' }],
        unevaluatedItems: { type: 'object', properties: { a: { type: 'string' } } },
      },
      valid: ['head', { a: 'x' }],
      extra: ['head', { a: 'x', rogue: 1 }],
    },
    {
      // CodeRabbit #645: the walker already treated `dependentSchemas` as an in-place applicator
      // and `evaluatesProperties` already counted it, but nothing exercised that traversal —
      // an untested branch is indistinguishable from a missing one.
      keyword: 'dependentSchemas',
      schema: {
        type: 'object',
        properties: { trigger: { type: 'string' } },
        dependentSchemas: {
          trigger: {
            properties: { nested: { type: 'object', properties: { a: { type: 'string' } } } },
          },
        },
      },
      valid: { trigger: 't', nested: { a: 'x' } },
      extra: { trigger: 't', nested: { a: 'x', rogue: 1 } },
    },
    {
      keyword: 'if/then',
      schema: {
        type: 'object',
        properties: { kind: { type: 'string' } },
        if: { properties: { kind: { const: 'x' } }, required: ['kind'] },
        then: { properties: { extra: { type: 'string' } } },
      },
      valid: { kind: 'x', extra: 'e' },
      extra: { kind: 'x', rogue: 1 },
    },
  ])('closes objects reached through $keyword', ({ schema, valid, extra }) => {
    const validate = validator(schema);
    expect(validate(valid)).toBe(true);
    expect(validate(extra)).toBe(false);
  });

  // A node that evaluates NO properties of its own must not be marked: closing it would reject
  // every key of an otherwise-unconstrained object.
  it('leaves a schema that evaluates no properties unmarked', () => {
    const marked = markUnevaluatedPropertiesFalse({ type: 'object' }) as {
      unevaluatedProperties?: boolean;
    };
    expect(marked.unevaluatedProperties).toBeUndefined();
  });
});

// resolveResponseSchema's two fail-loud guards exist so a gate can never "validate" nothing and
// stay green. Neither shape exists in today's openapi.yaml, so both are pinned against a synthetic
// doc — an untested guard is indistinguishable from a missing one.
describe('resolveResponseSchema vacuity guards (#640)', () => {
  function docWithResponse(response: unknown): OpenApiDoc {
    return { paths: { '/synthetic': { get: { responses: { '200': response } } } } };
  }

  it('throws for an application/json response documenting no schema', () => {
    const doc = docWithResponse({ content: { 'application/json': {} } });
    expect(() => resolveResponseSchema(doc, 'get', '/synthetic', 200)).toThrow(
      /application\/json response with no schema/
    );
  });

  it('no-ops (returns undefined) for a documented response with no application/json at all', () => {
    const doc = docWithResponse({ content: { 'application/pdf': { schema: { type: 'string' } } } });
    expect(resolveResponseSchema(doc, 'get', '/synthetic', 200)).toBeUndefined();
  });

  it('still throws for a status the operation does not document', () => {
    const doc = docWithResponse({
      content: { 'application/json': { schema: { type: 'object' } } },
    });
    expect(() => resolveResponseSchema(doc, 'get', '/synthetic', 404)).toThrow(
      /documents no 404 response/
    );
  });
});

// operationParamKeys() feeds INV-4; anything it silently under-reports becomes an INV-4 check that
// passes vacuously. Synthetic docs (no such op exists in openapi.yaml yet) pin the two ways that
// could happen: a body carrying BOTH a base `properties` map and `oneOf` branches, and a body
// composed in a way this narrow reader cannot destructure at all.
describe('operationParamKeys body-key derivation', () => {
  function docWithBodySchema(schema: unknown): OpenApiDoc {
    return {
      paths: {
        '/synthetic': {
          post: { requestBody: { content: { 'application/json': { schema } } }, responses: {} },
        },
      },
    };
  }

  it('unions base properties with every oneOf branch instead of letting the base win', () => {
    const doc = docWithBodySchema({
      properties: { kind: {} },
      oneOf: [{ properties: { branchA: {} } }, { properties: { branchB: {} } }],
    });
    const { body } = operationParamKeys(doc, 'post', '/synthetic');
    expect([...body].sort((a, b) => a.localeCompare(b))).toEqual(['branchA', 'branchB', 'kind']);
  });

  it('throws for a documented requestBody whose top-level keys cannot be derived', () => {
    // allOf composition is not destructured by this reader — returning {} would make INV-4 green
    // for an operation whose params were never actually compared.
    const doc = docWithBodySchema({ allOf: [{ properties: { hidden: {} } }] });
    expect(() => operationParamKeys(doc, 'post', '/synthetic')).toThrow(/pass vacuously/);
  });
});

// INV-5 (#403) drives an MCP tool, wraps its BARE payload as the REST envelope
// `{ success: true, data: <payload> }`, and reuses assertResponse to validate it against the
// mapped op's OpenAPI response schema. These pin that the reuse has teeth for an array-typed
// `data` schema (the shape the driven list-read tools return) — a malformed payload must fail.
describe('INV-5 envelope-wrap reuse (assertResponse teeth)', () => {
  it('rejects a malformed enveloped tool payload against an array data schema', async () => {
    // GET /projects `data` is an array of ProjectListItem — a string must not validate.
    await expect(
      assertResponse('get', '/projects', 200, { success: true, data: 'not-an-array' })
    ).rejects.toThrow(/does not match/i);
  });

  it('accepts a well-formed enveloped tool payload against an array data schema', async () => {
    await expect(
      assertResponse('get', '/projects', 200, { success: true, data: [] })
    ).resolves.toBeUndefined();
  });
});

// #377 — actorLabel is threaded through 5 write call sites purely as an additive request
// field; these tests pin the openapi.yaml side of that: the 4 existing request bodies (plus
// the MergeRequest component, which is `additionalProperties: false` and would otherwise
// reject a caller-supplied actorLabel outright) document the new optional field, accept-as-note
// gains its first-ever requestBody, and — the invariant this work must never violate — every
// touched operation's success-response shape is byte-identical to its pre-#377 form. Raw
// (un-dereferenced) parsing keeps the response fingerprint a small `$ref` pointer / inline
// literal instead of SpecNode's full (self-referential) resolved tree.
describe('actorLabel additive request coverage (#377)', () => {
  interface DataEnvelopeResponse {
    content: {
      'application/json': {
        schema: { allOf: [unknown, { required: string[]; properties: { data: unknown } }] };
      };
    };
  }

  function successDataSchema(op: RawOperation, status: string): unknown {
    const res = op.responses[status] as DataEnvelopeResponse;
    return res.content['application/json'].schema.allOf[1].properties.data;
  }

  function sortedStatusCodes(op: RawOperation): string[] {
    return Object.keys(op.responses).sort((a, b) => a.localeCompare(b));
  }

  const WRITE_OPS = [
    {
      op: 'insertParagraph',
      path: '/specs/{id}/paragraphs',
      method: 'post' as const,
      successStatus: '201',
      statuses: ['201', '400', '403', '404', '409', '422', '500'],
      successDataRef: { $ref: '#/components/schemas/SpecNode' },
    },
    {
      op: 'updateParagraph',
      path: '/specs/{id}/paragraphs/{nodeId}',
      method: 'patch' as const,
      successStatus: '200',
      // 422 added (#519, ADR-072 decision 3): a direct write to a locked
      // `object` row is rejected — its content is a captured OOXML blob,
      // editable only through its `objectText` children.
      statuses: ['200', '400', '403', '404', '409', '422', '500'],
      successDataRef: { $ref: '#/components/schemas/SpecNode' },
    },
    {
      op: 'removeParagraph',
      path: '/specs/{id}/paragraphs/{nodeId}/removal',
      method: 'patch' as const,
      successStatus: '200',
      statuses: ['200', '400', '403', '404', '409', '422', '500'],
      successDataRef: { $ref: '#/components/schemas/SpecNode' },
    },
  ];

  it.each(WRITE_OPS)(
    '$op request body documents an optional actorLabel',
    async ({ path, method, successStatus, statuses, successDataRef }) => {
      const raw = (await loadRawSpec()) as RawPaths;
      const op = raw.paths[path]?.[method];
      if (!op) throw new Error(`no raw operation at ${method} ${path}`);
      const schema = op.requestBody?.content['application/json'].schema;
      expect(schema?.properties?.['actorLabel'], 'actorLabel property documented').toBeDefined();
      expect(schema?.required ?? [], 'actorLabel is optional, not required').not.toContain(
        'actorLabel'
      );

      // Invariant: this op's response shape is untouched by the request-body addition.
      expect(sortedStatusCodes(op)).toEqual([...statuses].sort((a, b) => a.localeCompare(b)));
      expect(successDataSchema(op, successStatus)).toEqual(successDataRef);
    }
  );

  // mergeSpecDiff's requestBody is `$ref: MergeRequest` (a shared component, not an inline
  // schema), so actorLabel lives on the component — asserted separately below — while this
  // pins the op itself still points at that same component and its response is untouched.
  it('mergeSpecDiff requestBody still points at MergeRequest; response shape untouched', async () => {
    const raw = (await loadRawSpec()) as RawPaths;
    const op = raw.paths['/specs/{id}/merge']?.post;
    if (!op) throw new Error('no raw operation at post /specs/{id}/merge');
    expect(op.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/MergeRequest',
    });
    expect(sortedStatusCodes(op)).toEqual(['200', '400', '404', '409', '500']);
    expect(successDataSchema(op, '200')).toEqual({ $ref: '#/components/schemas/MergeResult' });
  });

  it('MergeRequest is additionalProperties:false and must list actorLabel explicitly', async () => {
    const raw = (await loadRawSpec()) as RawPaths;
    const mergeRequest = raw.components.schemas['MergeRequest'];
    if (!mergeRequest) throw new Error('MergeRequest component missing from openapi.yaml');
    expect(mergeRequest.additionalProperties).toBe(false);
    expect(mergeRequest.properties?.['actorLabel']).toBeDefined();
    expect(mergeRequest.required ?? []).not.toContain('actorLabel');
  });

  it('acceptCommentAsNote gains its first requestBody, optional, actorLabel-only', async () => {
    const raw = (await loadRawSpec()) as RawPaths;
    const path = '/specs/{id}/paragraphs/{nodeId}/comments/{index}/accept-as-note';
    const op = raw.paths[path]?.post;
    if (!op) throw new Error(`no raw operation at post ${path}`);
    expect(op.requestBody, 'requestBody now documented').toBeDefined();
    expect(op.requestBody?.required, 'body stays optional (route was bodyless pre-#377)').not.toBe(
      true
    );
    const schema = op.requestBody?.content['application/json'].schema;
    expect(schema?.properties?.['actorLabel']).toBeDefined();
    expect(schema?.required ?? []).not.toContain('actorLabel');

    // Invariant: the 201 response shape (noteId) is untouched by the new requestBody.
    expect(sortedStatusCodes(op)).toEqual(['201', '400', '403', '404', '409', '422', '500']);
    expect(successDataSchema(op, '201')).toEqual({
      type: 'object',
      required: ['noteId'],
      properties: { noteId: { type: 'string', format: 'uuid' } },
    });
  });
});

// #549 — operationParamKeys() feeds INV-4 (MCP tool inputSchema vs. its mapped REST op).
// These pin the boundary invariants: total over every real op, never vacuously empty for an
// op with a real requestBody, plus one worked example per source branch (direct properties,
// oneOf union, multipart fallback) and the unknown-op failure mode.
describe('operationParamKeys()', () => {
  it('throws for a method+path that is not a real operation', async () => {
    const doc = await loadSpec();
    expect(() => operationParamKeys(doc, 'get', '/not-a-real-path')).toThrow(
      /No OpenAPI operation: get \/not-a-real-path/
    );
  });

  it('is total: never throws for any real operation in openapi.yaml', async () => {
    const doc = await loadSpec();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of HTTP_METHODS) {
        if (item[method] === undefined) continue;
        expect(() => operationParamKeys(doc, method, path)).not.toThrow();
      }
    }
  });

  it('is never vacuously empty for an operation with a real requestBody', async () => {
    const doc = await loadSpec();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of HTTP_METHODS) {
        const raw = item[method] as { requestBody?: { content?: unknown } } | undefined;
        if (raw?.requestBody?.content === undefined) continue;
        const { body } = operationParamKeys(doc, method, path);
        expect(body.size, `${method} ${path} requestBody yields no keys`).toBeGreaterThan(0);
      }
    }
  });

  it('collects operation-level query param names', async () => {
    const doc = await loadSpec();
    const { query } = operationParamKeys(doc, 'get', '/search');
    expect(query).toEqual(
      new Set(['q', 'libraryId', 'projectId', 'division', 'part', 'nodeType', 'limit'])
    );
  });

  it('excludes path params — they are not documented under `parameters[].in === query`', async () => {
    const doc = await loadSpec();
    const { query } = operationParamKeys(doc, 'get', '/specs/{id}');
    expect(query.has('id')).toBe(false);
  });

  it('unions oneOf branch properties for a composed request body', async () => {
    const doc = await loadSpec();
    const { body } = operationParamKeys(
      doc,
      'put',
      '/libraries/{libraryId}/divisions/{division}/general-spec'
    );
    expect(body).toEqual(new Set(['generalSpecId', 'notes', 'status']));
  });

  it('reads direct top-level properties for a plain JSON request body', async () => {
    const doc = await loadSpec();
    const { body } = operationParamKeys(doc, 'post', '/specs/{id}/paragraphs');
    expect(body.has('actorLabel')).toBe(true);
  });

  it('falls back to multipart/form-data properties for a file-upload op', async () => {
    const doc = await loadSpec();
    const { body } = operationParamKeys(doc, 'post', '/parse');
    expect(body).toEqual(new Set(['file', 'section', 'title', 'numberingProfileId']));
  });

  it('yields an empty ParamSet for an operation with no params and no body', async () => {
    const doc = await loadSpec();
    const { query, body } = operationParamKeys(doc, 'get', '/health');
    expect(query.size).toBe(0);
    expect(body.size).toBe(0);
  });
});
