// src/mcp/contract-schema-sharing-map.ts
//
// Item 5 (#549): schema-INSTANCE-sharing gate. INV-4 (contract-request-parity)
// checks that a tool's flat argument KEYS match its REST op's params — it says
// nothing about whether an object-level `.strict()`/`.check()` RULE on the REST
// body schema survives being handed to the MCP SDK. A `{ ...Schema.shape }`
// spread carries every field but silently drops that rule (the SDK rebuilds a
// plain `z.object(shape)` from the raw shape); `Schema` or `Schema.extend(...)`
// passed through unchanged keeps it (`isFullSchemaInstance`, tool-schema-
// introspect.ts).
//
// OPS_WITH_OBJECT_LEVEL_RULE is the audited candidate list: every REST op whose
// mapped body schema (or a schema nested inside it) carries an OBJECT-level rule
// — `.check()`/`.strict()` chained directly onto a `z.object({...})` result, not
// a per-FIELD check like `.check(z.minLength(1))` on a string/array field, which
// survives a `.shape` spread fine because spreading only discards the OUTER
// object's own rule, never a field's. Seeded from a full grep of every
// `.check((ctx) =>` / `.strict()` in src/ast/*.ts, cross-referenced against which
// schema an MCP tool's registered `inputSchema` is actually built from (a rule on
// a schema no MCP tool ever touches — e.g. inference-schemas.ts's
// SignalProvenanceSchema, spec-tree-schemas.ts's ClassificationEvidenceSchema —
// isn't in scope: this map exists to gate the MCP surface, not audit every Zod
// schema in the codebase).
export const OPS_WITH_OBJECT_LEVEL_RULE: ReadonlyMap<string, string> = new Map([
  [
    'post /specs/{}/paragraphs/{}/associations',
    'CreateAssociationBodySchema.check() (association-schemas.ts:19) — the DMS-pair/url ' +
      'presence rule.',
  ],
  [
    'put /libraries/{}/header-footer',
    'HeaderFooterCompositionWriteSchema.check() (header-footer-schemas.ts:234) — the ' +
      'transport-size budget.',
  ],
  [
    'put /projects/{}/header-footer',
    'See put /libraries/{}/header-footer — same HeaderFooterCompositionWriteSchema.check().',
  ],
  [
    'put /packages/{}/header-footer',
    'See put /libraries/{}/header-footer — same HeaderFooterCompositionWriteSchema.check().',
  ],
  [
    'put /revisions/{}/header-footer',
    'See put /libraries/{}/header-footer — same HeaderFooterCompositionWriteSchema.check().',
  ],
  [
    'post /projects/{}/submittal-register',
    'SubmittalRegisterBodySchema.check() (submittal-register-schemas.ts:7) — the ' +
      'duplicate-specIds refinement.',
  ],
  [
    'put /projects/{}/required-sections',
    'RequiredSectionsBodySchema.check() (required-sections-schemas.ts:20) — the sections-XOR-' +
      'seedFrom + no-duplicates rule.',
  ],
  [
    'put /projects/{}/packages/{}/required-sections',
    'See put /projects/{}/required-sections — same RequiredSectionsBodySchema.check().',
  ],
  [
    'put /libraries/{}/divisions/{}/general-spec',
    'SetDivisionGeneralSpecBodySchema.check() (schemas.ts:95) — the generalSpecId-XOR-' +
      "status='not_applicable' rule.",
  ],
  [
    'put /projects/{}/divisions/{}/general-spec',
    'See put /libraries/{}/divisions/{}/general-spec — same SetDivisionGeneralSpecBodySchema.check().',
  ],
  [
    'patch /templates/{}',
    'PatchTemplateBodySchema.check() (style-schemas.ts:122) — the non-empty-patch ' +
      '(name or owner) rule.',
  ],
  [
    'patch /numbering-profiles/{}',
    'PatchNumberingProfileBodySchema.check() (style-schemas.ts:167) — the non-empty-patch ' +
      '(name or rules) rule — PLUS NumberingProfileSchema.check() x2 (numbering-profile-' +
      'schema.ts:206-207) nested at its `rules` field.',
  ],
  [
    'post /specs/{}/generate',
    "GenerateBodySchema.strict() (generate-schemas.ts:21) — rejects a misspelled 'mdoe' " +
      "instead of silently no-op'ing the ADR-079 readiness gate.",
  ],
  [
    'put /libraries/{}/language-rules',
    'LanguageRulesSchema.strict() (language-rule-schemas.ts:34), nested (with its own ' +
      'LanguageRuleTermSchema.strict() members) at the `rules` field.',
  ],
  [
    'put /projects/{}/language-rules',
    'See put /libraries/{}/language-rules — same LanguageRulesSchema.strict().',
  ],
  [
    'post /packages/{}/revisions',
    'StructuredCreateRevisionBodySchema.strict() (revision-schemas.ts:119) — rejects an ' +
      'unrecognized top-level key (e.g. a stray legacy `label`) instead of silently dropping it.',
  ],
  [
    'post /libraries/{}/numbering-profiles',
    'NumberingProfileSchema.check() x2 (numbering-profile-schema.ts:206-207) — the ' +
      'articleIlvl-required + tier-matches-derived rules, nested at the `rules` field.',
  ],
]);

// Verified safe by direct inspection, not by the mechanical isFullSchemaInstance() check —
// each entry states WHY the rule survives despite the tool's top-level inputSchema failing
// (or never being subject to) that check. Two recurring, deliberate patterns:
//   - "nested field": the rule-bearing schema is passed as a single field's VALUE (e.g.
//     `config: HeaderFooterCompositionWriteSchema`), never spread — the SDK stores that field
//     as one opaque ZodType and validates it as a whole, so the rule runs intact even though
//     the surrounding tool shape is a raw `{ key: ZodType, ... }` literal.
//   - "handler re-validates": the tool's inputSchema is a `.shape` spread (loses the rule at
//     the SDK layer), but the handler itself re-parses the args against the full schema (or an
//     equivalent hand-built `.refine()`/`.strict()`) before using them — the rule still runs,
//     just after the SDK's own (looser) validation rather than as part of it.
// Expected to stay small: it exists for cases already independently proven safe, not as a
// place to wave through a real gap.
export const SCHEMA_SHARING_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'post /specs/{}/paragraphs/{}/associations',
    'handler re-validates: handleCreateAssociation (association-handlers.ts) safeParses the ' +
      'full CreateAssociationBodySchema against the raw args before use, by design (see its ' +
      "'Two-step parse' comment) — the SDK-level inputSchema is the flattened shape only " +
      'because path ids (specId/nodeId) must sit alongside the body fields in a single MCP ' +
      'args object.',
  ],
  [
    'put /libraries/{}/header-footer',
    'nested field: SetLibraryHeaderFooterShape carries `config: HeaderFooterCompositionWriteSchema` ' +
      "unchanged (see the 'CORRECTED (spike finding #1)' comment in header-footer-handlers.ts).",
  ],
  [
    'put /projects/{}/header-footer',
    'nested field: SetProjectHeaderFooterShape carries `config: HeaderFooterCompositionWriteSchema` unchanged.',
  ],
  [
    'put /packages/{}/header-footer',
    'nested field: SetPackageHeaderFooterShape carries `config: HeaderFooterCompositionWriteSchema` unchanged.',
  ],
  [
    'put /revisions/{}/header-footer',
    'nested field: SetRevisionHeaderFooterShape carries `config: HeaderFooterCompositionWriteSchema` unchanged.',
  ],
  [
    'put /projects/{}/required-sections',
    'handler re-validates: handleSetRequiredSections (required-sections-handlers.ts) ' +
      'safeParses the full RequiredSectionsBodySchema separately from the path-id args.',
  ],
  [
    'put /projects/{}/packages/{}/required-sections',
    'handler re-validates: handleSetPackageRequiredSections safeParses the full ' +
      'RequiredSectionsBodySchema separately from the path-id args.',
  ],
  [
    'put /libraries/{}/divisions/{}/general-spec',
    'handler re-validates: handleSetLibraryGeneralSpec (division-general-handlers.ts) ' +
      'safeParses the full SetDivisionGeneralSpecBodySchema separately from the owner args.',
  ],
  [
    'put /projects/{}/divisions/{}/general-spec',
    'handler re-validates: handleSetProjectGeneralSpec safeParses the full ' +
      'SetDivisionGeneralSpecBodySchema separately from the owner args.',
  ],
  [
    'patch /templates/{}',
    'handler re-validates: UpdateTemplateArgs (template-handlers.ts) wraps the spread shape in ' +
      'its own `.refine((v) => v.name !== undefined || v.owner !== undefined)` — a hand-built ' +
      'equivalent of PatchTemplateBodySchema.check(), asserted before the handler runs.',
  ],
  [
    'patch /numbering-profiles/{}',
    'handler re-validates + nested field: UpdateArgs (numbering-profile-crud-handlers.ts) ' +
      're-asserts the non-empty-patch rule via `.refine()`, and its `rules` field carries ' +
      'NumberingProfileSchema unchanged, so both underlying rules run.',
  ],
  [
    'put /libraries/{}/language-rules',
    'nested field: SetLibraryLanguageRulesShape carries `rules: LanguageRulesSchema` unchanged ' +
      '(language-rule-handlers.ts) — never spread.',
  ],
  [
    'put /projects/{}/language-rules',
    'nested field: SetProjectLanguageRulesShape carries `rules: LanguageRulesSchema` unchanged.',
  ],
  [
    'post /packages/{}/revisions',
    'handler re-validates: IssueArgs (package-revision-handlers.ts) is built with ' +
      '`z.strictObject(IssuePackageRevisionShape)`, which reinstates the unknownKeys=strict ' +
      'policy `.shape` drops — a hand-built equivalent of StructuredCreateRevisionBodySchema.strict().',
  ],
  [
    'post /libraries/{}/numbering-profiles',
    'nested field: CreateNumberingProfileShape carries `rules: NumberingProfileSchema` ' +
      'unchanged (numbering-profile-crud-handlers.ts) — never spread.',
  ],
]);

// Burn-down set: ops with a REAL gap (the SDK-level inputSchema loses the rule, and nothing
// re-asserts it), deferred to a follow-up issue rather than fixed in THIS PR — kept out of
// SCHEMA_SHARING_EXEMPT (which is only for VERIFIED-safe cases) so the gate stays honest about
// what's actually unresolved. Never both PENDING and EXEMPT for the same op.
//
// SELF-CLEANING: the gate asserts every entry here STILL fails isFullSchemaInstance() — an op
// whose gap gets closed makes its own entry fail, forcing deletion. So this set can never sit on
// an already-resolved gap, and a removed entry falls straight back into the main Item 5 check.
// Bounded on the other side by SCHEMA_SHARING_PENDING_BASELINE below.
export const SCHEMA_SHARING_PENDING: ReadonlySet<string> = new Set([
  // submittal_register spreads SubmittalRegisterBodySchema.shape into its inputSchema
  // (tools.ts), losing the duplicate-specIds .check() at the SDK layer — the same gap as the
  // EXEMPT handler-re-validates cases above. handleSubmittalRegister DOES independently
  // safeParse the full SubmittalRegisterBodySchema (submittal-register-handler.ts), so this is
  // not presently a live bug either. It stays PENDING rather than EXEMPT because #550 (REST↔MCP
  // parity audit) already owns consolidating this exact op's schema-sharing story end-to-end —
  // recording it EXEMPT here would let a partial, ad hoc fix quietly close out what #550 is
  // meant to resolve properly (e.g. switching to a shared `.extend()` reference instead of a
  // second parse). Never assert-failing in THIS PR's own test run; #550 promotes or fixes it.
  'post /projects/{}/submittal-register',
]);

/**
 * Item 5 ratchet baseline (#549). SCHEMA_SHARING_PENDING.size must never grow past this count,
 * mirroring INV5_READ_PENDING_BASELINE (contract-map.ts) and INV6_WRITE_PENDING_BASELINE
 * (contract-write-response-map.ts). Without it the burn-down set is the one place a future
 * schema-sharing divergence could be parked silently — the exact failure mode this gate exists to
 * close. Verified by direct count on 2026-08-03: the set held exactly 1 entry when the ratchet was
 * introduced. Lower it whenever an entry graduates out.
 */
export const SCHEMA_SHARING_PENDING_BASELINE = 1;
