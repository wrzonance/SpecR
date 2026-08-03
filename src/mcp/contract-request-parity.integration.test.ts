// src/mcp/contract-request-parity.integration.test.ts
// INV-4 (#549): every OpenAPI-documented query/body param an operation requires must be
// discoverable somewhere in its mapped MCP tool's inputSchema — a universal request-parameter-
// parity gate over the entire OP_TO_TOOL surface (the previous create_project-only check pinned
// this for exactly one op; this promotes it repo-wide). No DB access — pure static introspection
// against openapi.yaml + the registered tool schemas, so it needs no seeded fixtures.
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, ALL_TIERS } from './tools.js';
import { OP_TO_TOOL, INV4_PARAM_EXEMPT } from './contract-map.js';
import {
  OPS_WITH_OBJECT_LEVEL_RULE,
  SCHEMA_SHARING_EXEMPT,
  SCHEMA_SHARING_PENDING,
  SCHEMA_SHARING_PENDING_BASELINE,
  SCHEMA_SHARING_REJECT_PROBES,
} from './contract-schema-sharing-map.js';
import { toolInputKeys, isFullSchemaInstance, sdkRejects } from './tool-schema-introspect.js';
import {
  loadSpec,
  operationParamKeys,
  operationPathTemplates,
} from '../test-utils/contract/validate-response.js';
import type { ToolInputSchema } from './tool-registry.js';

function registeredSchemas(): ReadonlyMap<string, ToolInputSchema> {
  const server = new McpServer({ name: 'contract-request-parity', version: '0' });
  return registerTools(server, { allowedTiers: ALL_TIERS }).schemas;
}

describe('INV-4: request-parameter parity (REST op params <-> MCP tool inputSchema)', () => {
  const schemas = registeredSchemas();
  // EVERY mapped op is a case — exemptions are subtracted param-by-param below, never op-wide, so
  // an op excused for one renamed field is still gated on all its other fields.
  const parityCases = [...OP_TO_TOOL];

  it.each(parityCases)(
    '%s -> %s: every documented query/body param is in the tool inputSchema',
    async (op, tool) => {
      const doc = await loadSpec();
      const literalPath = operationPathTemplates(doc).get(op);
      expect(literalPath, `${op} has no matching literal path in openapi.yaml`).toBeDefined();
      const [method] = op.split(' ');
      const { query, body } = operationParamKeys(doc, method!, literalPath!);
      const expected = new Set([...query, ...body]);
      const excused = new Set(INV4_PARAM_EXEMPT.get(op)?.params ?? []);
      const actual = toolInputKeys(schemas.get(tool));
      const missing = [...expected].filter((key) => !actual.has(key) && !excused.has(key));
      expect(
        missing,
        `${tool} (${op}) is missing REST param(s) [${missing.join(', ')}] — either add them to ` +
          'the tool inputSchema, or add them to a reasoned INV4_PARAM_EXEMPT entry in ' +
          'contract-map.ts (field-scoped: list the specific params, not the whole op)'
      ).toEqual([]);
    }
  );

  // Self-cleaning exemption hygiene: an excused param must (a) really be documented by the op and
  // (b) really be absent from the tool. (a) catches a stale name left behind by an openapi rename;
  // (b) forces the waiver's removal once the tool adopts the param verbatim — so the exemption
  // list can never quietly suppress a check that has become unnecessary.
  it.each([...INV4_PARAM_EXEMPT])(
    'INV-4 exemption hygiene: %s excuses only params that are documented and genuinely absent',
    async (op, { params, reason }) => {
      expect(OP_TO_TOOL.has(op), `INV4_PARAM_EXEMPT references unknown op "${op}"`).toBe(true);
      expect(reason.length > 0, `INV4_PARAM_EXEMPT entry for "${op}" has an empty reason`).toBe(
        true
      );
      expect(params.length > 0, `INV4_PARAM_EXEMPT entry for "${op}" excuses no params`).toBe(true);
      const doc = await loadSpec();
      const literalPath = operationPathTemplates(doc).get(op);
      expect(literalPath, `${op} has no matching literal path in openapi.yaml`).toBeDefined();
      const [method] = op.split(' ');
      const { query, body } = operationParamKeys(doc, method!, literalPath!);
      const documented = new Set([...query, ...body]);
      const actual = toolInputKeys(schemas.get(OP_TO_TOOL.get(op)!));
      for (const param of params) {
        expect(
          documented.has(param),
          `INV4_PARAM_EXEMPT excuses "${param}" for ${op}, but openapi.yaml documents no such ` +
            'query/body param — the exemption is stale; drop or rename it'
        ).toBe(true);
        expect(
          actual.has(param),
          `INV4_PARAM_EXEMPT excuses "${param}" for ${op}, but the tool now declares it — the ` +
            'divergence is gone; delete this param from the exemption so the gate covers it'
        ).toBe(false);
      }
    }
  );
});

// ── Item 5 (#549): schema-instance-sharing gate ──────────────────────────────
// INV-4 above proves every REST param name is *discoverable* in a tool's inputSchema; it says
// nothing about whether an OBJECT-LEVEL `.strict()`/`.check()` rule on the REST body schema
// (cross-field refinements, unknown-key rejection) survives being handed to the MCP SDK. A
// `{ ...Schema.shape }` spread carries every field but silently drops that rule — the SDK
// rebuilds a plain `z.object(shape)` from the raw shape. OPS_WITH_OBJECT_LEVEL_RULE is the
// audited list of ops whose body schema carries such a rule; every entry must land in exactly
// one of three buckets — verified passing (isFullSchemaInstance), SCHEMA_SHARING_EXEMPT
// (verified safe some other way), or SCHEMA_SHARING_PENDING (a real, deferred gap) — never
// silently unaccounted for.
describe('Item 5: schema-instance-sharing (object-level rules survive SDK registration)', () => {
  const schemas = registeredSchemas();
  const checkedCases = [...OPS_WITH_OBJECT_LEVEL_RULE].filter(
    ([op]) => !SCHEMA_SHARING_EXEMPT.has(op) && !SCHEMA_SHARING_PENDING.has(op)
  );

  it.each(checkedCases)(
    '%s -> %s: the object-level rule survives (tool inputSchema is a full schema instance)',
    (op, rule) => {
      const tool = OP_TO_TOOL.get(op);
      expect(tool, `${op} is not in OP_TO_TOOL`).toBeDefined();
      expect(
        isFullSchemaInstance(schemas.get(tool!)),
        `${tool} (${op}) advertises inputSchema as a raw shape, silently dropping its object-` +
          `level rule (${rule}) — either register it via .extend()/the schema instance itself, ` +
          'or add a reasoned SCHEMA_SHARING_EXEMPT/SCHEMA_SHARING_PENDING entry in ' +
          'contract-schema-sharing-map.ts'
      ).toBe(true);
    }
  );

  // The structural check above is a PROXY, and it has a blind spot: `z.object({ ...Schema.shape })`
  // is a schema instance too, so it passes isFullSchemaInstance while having dropped the very rule
  // the gate is about (verified — see SCHEMA_SHARING_REJECT_PROBES). This proves the rule actually
  // RUNS by pushing a counterexample through the SDK's own validation path. Every checked op must
  // have a probe, so an op graduating out of EXEMPT/PENDING cannot enter the checked bucket with
  // only the weaker structural proof.
  it.each(checkedCases)(
    '%s -> %s: the object-level rule actually RUNS (SDK-level parse rejects a counterexample)',
    (op, rule) => {
      const probe = SCHEMA_SHARING_REJECT_PROBES.get(op);
      expect(
        SCHEMA_SHARING_REJECT_PROBES.has(op),
        `no SCHEMA_SHARING_REJECT_PROBES entry for checked op "${op}" — add an args object its ` +
          `rule (${rule}) must reject; the structural check alone cannot prove the rule survived`
      ).toBe(true);
      const tool = OP_TO_TOOL.get(op);
      expect(tool, `${op} is not in OP_TO_TOOL`).toBeDefined();
      expect(
        sdkRejects(schemas.get(tool!), probe),
        `${tool} (${op}) ACCEPTS ${JSON.stringify(probe)} at the SDK layer — its object-level ` +
          `rule (${rule}) is not running, even though the schema is registered as a full ` +
          'instance. A `z.object({ ...Schema.shape })` rebuild drops the rule while still looking ' +
          'structurally correct; register the schema itself or via .extend().'
      ).toBe(true);
    }
  );

  it('Item 5 probe hygiene: every reject-probe keys an op the main gate actually checks', () => {
    const checked = new Set(checkedCases.map(([op]) => op));
    for (const op of SCHEMA_SHARING_REJECT_PROBES.keys()) {
      expect(
        checked.has(op),
        `SCHEMA_SHARING_REJECT_PROBES has an entry for "${op}", which the main Item 5 gate does ` +
          'not check (it is exempt, pending, or has no object-level rule) — the probe never runs'
      ).toBe(true);
    }
  });

  it('Item 5 completeness: every OPS_WITH_OBJECT_LEVEL_RULE entry is checked, exempt, or pending — never both exempt and pending', () => {
    for (const op of OPS_WITH_OBJECT_LEVEL_RULE.keys()) {
      const inExempt = SCHEMA_SHARING_EXEMPT.has(op);
      const inPending = SCHEMA_SHARING_PENDING.has(op);
      expect(
        inExempt && inPending,
        `"${op}" is in both SCHEMA_SHARING_EXEMPT and SCHEMA_SHARING_PENDING`
      ).toBe(false);
    }
  });

  it('Item 5 hygiene: every SCHEMA_SHARING_EXEMPT entry keys a real object-level-rule op and carries a reason', () => {
    for (const [op, reason] of SCHEMA_SHARING_EXEMPT) {
      expect(
        OPS_WITH_OBJECT_LEVEL_RULE.has(op),
        `SCHEMA_SHARING_EXEMPT references an op with no OPS_WITH_OBJECT_LEVEL_RULE entry: "${op}"`
      ).toBe(true);
      expect(reason.length > 0, `SCHEMA_SHARING_EXEMPT entry for "${op}" has an empty reason`).toBe(
        true
      );
    }
  });

  it('Item 5 hygiene: every SCHEMA_SHARING_PENDING entry keys a real object-level-rule op', () => {
    for (const op of SCHEMA_SHARING_PENDING) {
      expect(
        OPS_WITH_OBJECT_LEVEL_RULE.has(op),
        `SCHEMA_SHARING_PENDING references an op with no OPS_WITH_OBJECT_LEVEL_RULE entry: "${op}"`
      ).toBe(true);
    }
  });

  // Self-cleaning burn-down. Every PENDING entry must describe a gap that is STILL REAL: the op's
  // tool must still register a raw shape. The moment the gap closes — e.g. #550 switching
  // submittal_register from a `.shape` spread to `.extend()` — this fails and demands the entry be
  // deleted, at which point the main gate above picks the op up and proves the rule survives.
  // Without this, a resolved gap could sit in PENDING forever, claiming an unresolved divergence
  // that no longer exists (the main gate filters pending ops out before checking them).
  it.each([...SCHEMA_SHARING_PENDING])(
    '%s: the deferred gap is still real (a fixed op must leave SCHEMA_SHARING_PENDING)',
    (op) => {
      const tool = OP_TO_TOOL.get(op);
      expect(tool, `${op} is not in OP_TO_TOOL`).toBeDefined();
      const schema = schemas.get(tool!);
      expect(schema, `${tool} (${op}) registers no inputSchema`).toBeDefined();
      expect(
        isFullSchemaInstance(schema),
        `${tool} (${op}) now registers a full schema instance, so its object-level rule survives ` +
          'and the deferred gap is CLOSED — delete this entry from SCHEMA_SHARING_PENDING (the ' +
          'main Item 5 gate then covers the op) and lower SCHEMA_SHARING_PENDING_BASELINE.'
      ).toBe(false);
    }
  );

  it('Item 5 ratchet: schema-sharing pending burn-down never grows', () => {
    expect(SCHEMA_SHARING_PENDING.size).toBeLessThanOrEqual(SCHEMA_SHARING_PENDING_BASELINE);
  });

  // Anti-laundering pin: while the #550 gap is open, that op must sit in PENDING and never be
  // moved into SCHEMA_SHARING_EXEMPT (reserved for VERIFIED-safe cases). Guarded on the gap still
  // being open so it cannot fight the self-cleaning gate above — once #550's fix lands, that gate
  // demands the PENDING entry be deleted and this pin goes quiet instead of pinning a stale entry
  // in place. Delete this test together with the entry.
  it('submittal_register: while the #550 gap is open it stays PENDING, never silently EXEMPT', () => {
    const op = 'post /projects/{}/submittal-register';
    const tool = OP_TO_TOOL.get(op);
    expect(tool, `${op} is not in OP_TO_TOOL`).toBeDefined();
    if (isFullSchemaInstance(schemas.get(tool!))) return; // gap closed — the self-cleaning gate owns it
    expect(SCHEMA_SHARING_PENDING.has(op)).toBe(true);
    expect(SCHEMA_SHARING_EXEMPT.has(op)).toBe(false);
  });
});
