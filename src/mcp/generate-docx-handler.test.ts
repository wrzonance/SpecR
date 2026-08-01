import { describe, it, expect, vi, beforeEach } from 'vitest';

// ADR-079/#567 — mirrors src/api/readiness-guard.test.ts's db/index.js mock
// shape: a stand-in ReadinessBlockedError class (so `instanceof` works the
// same way the REST test's stub does) plus a mockable assertReadyForFinal.
// The real gate/override semantics are pinned once, at their own source of
// truth (db/queries/readiness-gate.test.ts); this file only pins THIS
// boundary's wiring — that generate_docx forwards mode/overrideReadinessGate
// and maps a block into an MCP-shaped toolError.
vi.mock('../db/index.js', () => ({
  pool: {},
  getSpecTree: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateByName: vi.fn(),
  resolveSpecGenerationContext: vi.fn(),
  assertReadyForFinal: vi.fn(),
  ReadinessBlockedError: class ReadinessBlockedError extends Error {
    readonly findings: readonly unknown[];
    constructor(message: string, options: { findings: readonly unknown[] }) {
      super(message);
      this.findings = options.findings;
    }
  },
}));

vi.mock('../generator/index.js', () => ({
  generateDocx: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const FAKE_SPEC_ID = '10000000-0000-4000-8000-000000000001';
const UNKNOWN_SPEC_ID = '00000000-0000-0000-0000-000000000000';
const FAKE_TEMPLATE_ID = '20000000-0000-4000-8000-000000000001';

const STUB_TREE = {
  tree: { id: FAKE_SPEC_ID, section: '09 91 00', title: 'Test Spec', parts: [] },
  refs: [],
};

const NO_PROJECT_CONTEXT = { sectionNumberFormat: null, headerFooter: null };

/** Wires every DB mock generate_docx touches to its byte-identical, pre-#567
 *  baseline: unresolved spec's sole owning project (no fallback format, no
 *  header/footer), and the seeded default template resolving with no rules —
 *  the shared no-op starting point every test below narrows from. */
async function stubBaselineResolution(): Promise<void> {
  const db = await import('../db/index.js');
  vi.mocked(db.getSpecTree).mockResolvedValue(STUB_TREE as never);
  vi.mocked(db.getTemplateByName).mockResolvedValue(null);
  vi.mocked(db.resolveSpecGenerationContext).mockResolvedValue(NO_PROJECT_CONTEXT);
}

describe('handleGenerateDocx', () => {
  it('never throws past its own catch — a generateDocx rejection surfaces as isError', async () => {
    await stubBaselineResolution();
    const generator = await import('../generator/index.js');
    vi.mocked(generator.generateDocx).mockRejectedValueOnce(new Error('render boom'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID });

    expect(result).toMatchObject({ isError: true });
  });

  it('unknown spec -> isError, no template/generation calls', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecTree).mockResolvedValueOnce(null);
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: UNKNOWN_SPEC_ID });

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.getTemplate)).not.toHaveBeenCalled();
    expect(vi.mocked(db.resolveSpecGenerationContext)).not.toHaveBeenCalled();
  });

  it('unknown templateId -> isError "template not found", mirroring REST\'s 404', async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    vi.mocked(db.getTemplate).mockResolvedValueOnce(null);
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID, templateId: FAKE_TEMPLATE_ID });

    expect(result).toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('template not found');
    expect(text).toContain(FAKE_TEMPLATE_ID);
    expect(vi.mocked(db.getTemplateByName)).not.toHaveBeenCalled();
  });

  it("explicit templateId resolves that template's own rules, not the seeded default", async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    const generator = await import('../generator/index.js');
    const explicitRules = [{ nodeType: 'part', properties: {} }];
    vi.mocked(db.getTemplate).mockResolvedValueOnce({ rules: explicitRules } as never);
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID, templateId: FAKE_TEMPLATE_ID });

    expect(result).not.toMatchObject({ isError: true });
    expect(vi.mocked(db.getTemplateByName)).not.toHaveBeenCalled();
    expect(vi.mocked(generator.generateDocx)).toHaveBeenCalledWith(
      STUB_TREE.tree,
      explicitRules,
      undefined
    );
  });

  it("body sectionNumberFormat wins over the owning project's stored default (REST parity)", async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    const generator = await import('../generator/index.js');
    vi.mocked(db.resolveSpecGenerationContext).mockResolvedValueOnce({
      sectionNumberFormat: 'ufgs',
      headerFooter: null,
    } as never);
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    await handleGenerateDocx({ specId: FAKE_SPEC_ID, sectionNumberFormat: 'canonical' });

    expect(vi.mocked(generator.generateDocx)).toHaveBeenCalledWith(STUB_TREE.tree, undefined, {
      sectionNumberFormat: 'canonical',
    });
  });

  it("missing body format falls back to the owning project's stored default", async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    const generator = await import('../generator/index.js');
    vi.mocked(db.resolveSpecGenerationContext).mockResolvedValueOnce({
      sectionNumberFormat: 'ufgs',
      headerFooter: null,
    } as never);
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    await handleGenerateDocx({ specId: FAKE_SPEC_ID });

    expect(vi.mocked(generator.generateDocx)).toHaveBeenCalledWith(STUB_TREE.tree, undefined, {
      sectionNumberFormat: 'ufgs',
    });
  });

  it('no owning project and no body format -> generateDocx options omit sectionNumberFormat entirely', async () => {
    await stubBaselineResolution();
    const generator = await import('../generator/index.js');
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    await handleGenerateDocx({ specId: FAKE_SPEC_ID });

    expect(vi.mocked(generator.generateDocx)).toHaveBeenCalledWith(
      STUB_TREE.tree,
      undefined,
      undefined
    );
  });

  // #567 review finding: the section-number format and the header/footer must
  // come from ONE ownership snapshot. Two independent reads left a window in
  // which a project-membership change between them could pair Project A's
  // numbering with Project B's branding — the race ADR-079/#304 closed for the
  // REST path. Asserting the single call is what keeps it closed.
  it('layers header/footer onto options from the SAME ownership snapshot as the section format', async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    const generator = await import('../generator/index.js');
    const composition = { header: { left: { content: [] } } };
    vi.mocked(db.resolveSpecGenerationContext).mockResolvedValueOnce({
      sectionNumberFormat: 'ufgs',
      headerFooter: { composition, fieldValues: { projectName: 'Acme HQ' } },
    } as never);
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    await handleGenerateDocx({ specId: FAKE_SPEC_ID });

    expect(vi.mocked(db.resolveSpecGenerationContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.resolveSpecGenerationContext)).toHaveBeenCalledWith(FAKE_SPEC_ID, {});
    const call = vi.mocked(generator.generateDocx).mock.calls[0];
    expect(call?.[2]).toMatchObject({
      sectionNumberFormat: 'ufgs',
      headerFooter: { composition, current: { projectName: 'Acme HQ' } },
    });
  });

  it('returns the spec section/title/sizeBytes/contentBase64 payload on success', async () => {
    await stubBaselineResolution();
    const generator = await import('../generator/index.js');
    const buf = Buffer.from('fake docx bytes');
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(buf);
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID });

    expect(result).not.toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    const parsed = JSON.parse(text) as {
      specId: string;
      section: string;
      title: string;
      sizeBytes: number;
      contentBase64: string;
    };
    expect(parsed).toEqual({
      specId: FAKE_SPEC_ID,
      section: STUB_TREE.tree.section,
      title: STUB_TREE.tree.title,
      sizeBytes: buf.byteLength,
      contentBase64: buf.toString('base64'),
    });
  });
});

// #567 — generate_docx previously had no mode/overrideReadinessGate
// wiring at all (readiness_report's own description called this out as a
// documented gap, #539). checkMcpReadinessGate mirrors
// src/api/readiness-guard.ts's enforceReadinessGate: same
// assertReadyForFinal/ReadinessBlockedError call, mapped to a ToolError
// instead of an Express 422 write.
describe('checkMcpReadinessGate (ADR-079 mirror)', () => {
  it('returns blocked:false and writes nothing when assertReadyForFinal no-ops (INV-1/INV-2/INV-3)', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.assertReadyForFinal).mockImplementationOnce(() => undefined);
    const { checkMcpReadinessGate } = await import('./generate-docx-handler.js');

    const outcome = checkMcpReadinessGate([{ tree: STUB_TREE.tree }], 'final', undefined);

    expect(outcome).toEqual({ blocked: false });
  });

  it('returns blocked:true with a toolError carrying {error, findings} on ReadinessBlockedError (INV-4)', async () => {
    const db = await import('../db/index.js');
    const findings = [{ type: 'specifier_note_present' as const, nodeId: 'n1', text: 'note' }];
    vi.mocked(db.assertReadyForFinal).mockImplementationOnce(() => {
      throw new db.ReadinessBlockedError(
        'final issuance blocked: 1 readiness finding(s) outstanding',
        { findings }
      );
    });
    const { checkMcpReadinessGate } = await import('./generate-docx-handler.js');

    const outcome = checkMcpReadinessGate([{ tree: STUB_TREE.tree }], 'final', undefined);

    expect(outcome.blocked).toBe(true);
    if (!outcome.blocked) throw new Error('unreachable');
    expect(outcome.toolError).toMatchObject({ isError: true });
    const text = outcome.toolError.content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { error: string; findings: readonly unknown[] };
    expect(parsed.error).toContain('final issuance blocked: 1 readiness finding(s) outstanding');
    expect(parsed.findings).toEqual(findings);
  });

  it('rethrows an error that is not ReadinessBlockedError rather than swallowing it (INV-13)', async () => {
    const db = await import('../db/index.js');
    const unrelated = new Error('unexpected failure');
    vi.mocked(db.assertReadyForFinal).mockImplementationOnce(() => {
      throw unrelated;
    });
    const { checkMcpReadinessGate } = await import('./generate-docx-handler.js');

    expect(() => checkMcpReadinessGate([{ tree: STUB_TREE.tree }], 'final', undefined)).toThrow(
      unrelated
    );
  });
});

describe('handleGenerateDocx — readiness gate wiring (#567)', () => {
  it("forwards args.mode/args.overrideReadinessGate to the gate, scoped to the spec's own tree", async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    const generator = await import('../generator/index.js');
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    await handleGenerateDocx({ specId: FAKE_SPEC_ID, mode: 'final', overrideReadinessGate: true });

    expect(vi.mocked(db.assertReadyForFinal)).toHaveBeenCalledWith(
      [{ tree: STUB_TREE.tree }],
      'final',
      true
    );
  });

  it("mode: 'draft' (or omitted) never blocks — generateDocx still runs", async () => {
    await stubBaselineResolution();
    const generator = await import('../generator/index.js');
    vi.mocked(generator.generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID });

    expect(result).not.toMatchObject({ isError: true });
    expect(vi.mocked(generator.generateDocx)).toHaveBeenCalled();
  });

  it("mode: 'final' blocked -> isError carrying REST's {error, findings} shape, generateDocx never called", async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    const generator = await import('../generator/index.js');
    const findings = [{ type: 'open_comment' as const, nodeId: 'c1', text: 'x', author: 'Jane' }];
    vi.mocked(db.assertReadyForFinal).mockImplementationOnce(() => {
      throw new db.ReadinessBlockedError(
        'final issuance blocked: 1 readiness finding(s) outstanding',
        {
          findings,
        }
      );
    });
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID, mode: 'final' });

    expect(result).toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { error: string; findings: readonly unknown[] };
    expect(parsed.findings).toEqual(findings);
    expect(vi.mocked(generator.generateDocx)).not.toHaveBeenCalled();
  });

  it('a blocked gate short-circuits before the section-format/header-footer DB round trip', async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    vi.mocked(db.assertReadyForFinal).mockImplementationOnce(() => {
      throw new db.ReadinessBlockedError(
        'final issuance blocked: 1 readiness finding(s) outstanding',
        {
          findings: [{ type: 'open_comment' as const, nodeId: 'c1', text: 'x', author: 'Jane' }],
        }
      );
    });
    vi.mocked(db.resolveSpecGenerationContext).mockClear();
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    await handleGenerateDocx({ specId: FAKE_SPEC_ID, mode: 'final' });

    expect(vi.mocked(db.resolveSpecGenerationContext)).not.toHaveBeenCalled();
  });

  it('a gate error that is not ReadinessBlockedError surfaces via the generic catch-all, never swallowed silently', async () => {
    await stubBaselineResolution();
    const db = await import('../db/index.js');
    vi.mocked(db.assertReadyForFinal).mockImplementationOnce(() => {
      throw new Error('pg connection reset');
    });
    const { handleGenerateDocx } = await import('./generate-docx-handler.js');

    const result = await handleGenerateDocx({ specId: FAKE_SPEC_ID, mode: 'final' });

    expect(result).toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).not.toContain('pg connection reset');
  });
});
