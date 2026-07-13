import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { HeaderFooterComposition } from '../ast/index.js';
import { DatabaseError } from '../db/errors.js';

vi.mock('../db/index.js', () => ({
  getSpecTree: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateByName: vi.fn(),
  findProjectById: vi.fn(),
  resolveSpecGenerationContext: vi.fn(),
  pool: {},
}));
vi.mock('../generator/index.js', () => ({
  generateDocx: vi.fn(),
  generateManual: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('safeFilename', () => {
  it('generate: filename preserves dotted suffix', async () => {
    const { safeFilename } = await import('./generate.js');
    expect(safeFilename('26 00 13.10', 'Panelboards')).toBe('26-00-13.10-Panelboards.docx');
  });

  it('generate: agency form keeps dot, spaces become dashes', async () => {
    const { safeFilename } = await import('./generate.js');
    expect(safeFilename('01 32 01.00 10', 'QC')).toBe('01-32-01.00-10-QC.docx');
  });

  it('generate: base form unchanged behavior', async () => {
    const { safeFilename } = await import('./generate.js');
    expect(safeFilename('27 21 00', 'Structured Cabling')).toBe('27-21-00-Structured-Cabling.docx');
  });
});

describe('manualFilename', () => {
  it('generate: spaces become dashes and dotted-suffix chars drop', async () => {
    const { manualFilename } = await import('./generate.js');
    expect(manualFilename('Acme HQ Renovation')).toBe('Acme-HQ-Renovation-manual.docx');
  });

  it('generate: empty / symbol-only name falls back to "project"', async () => {
    const { manualFilename } = await import('./generate.js');
    expect(manualFilename('')).toBe('project-manual.docx');
    expect(manualFilename('@@@')).toBe('project-manual.docx');
  });

  it('generate: trailing dash from 80-char truncation is trimmed', async () => {
    // The space lands at index 79, becoming a dash that slice(0,80) keeps at the
    // boundary. Trimming must run AFTER the slice or that dash survives into the
    // filename (would yield "A…A--manual.docx").
    const { manualFilename } = await import('./generate.js');
    const name = `${'A'.repeat(79)} extra`;
    expect(manualFilename(name)).toBe(`${'A'.repeat(79)}-manual.docx`);
  });
});

const SPEC_ID = '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef';

async function setupSpecGenerate(): Promise<void> {
  const { getSpecTree, getTemplateByName, resolveSpecGenerationContext } =
    await import('../db/index.js');
  const { generateDocx } = await import('../generator/index.js');
  vi.mocked(getSpecTree).mockResolvedValueOnce({
    tree: { id: SPEC_ID, section: '09 91 00', title: 'Painting', parts: [] },
    references: [],
  });
  vi.mocked(getTemplateByName).mockResolvedValueOnce(null);
  // Default: orphan/ambiguous spec — no format fallback, no configured
  // header/footer — keeps the pre-#267/#304 `options` assertions byte-identical
  // unless a test below overrides this mock to return a populated snapshot.
  vi.mocked(resolveSpecGenerationContext).mockResolvedValueOnce({
    sectionNumberFormat: null,
    headerFooter: null,
  });
  vi.mocked(generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
}

describe('generateHandler', () => {
  it('generate: request sectionNumberFormat wins over the resolved project snapshot', async () => {
    const { generateDocx, resolveSpecGenerationContext } = await loadSpecMocks();
    // A populated snapshot format still loses to an explicit body format.
    vi.mocked(resolveSpecGenerationContext)
      .mockReset()
      .mockResolvedValueOnce({ sectionNumberFormat: 'compact', headerFooter: null });
    const { generateHandler } = await import('./generate.js');
    await generateHandler(
      { params: { id: SPEC_ID }, body: { sectionNumberFormat: 'dots' } } as unknown as Request,
      mockRes()
    );
    expect(generateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ section: '09 91 00' }),
      undefined,
      { sectionNumberFormat: 'dots' }
    );
  });

  it("generate: falls back to the spec's sole project default when body omits the format", async () => {
    const { generateDocx, resolveSpecGenerationContext } = await loadSpecMocks();
    vi.mocked(resolveSpecGenerationContext)
      .mockReset()
      .mockResolvedValueOnce({ sectionNumberFormat: 'dots', headerFooter: null });
    const { generateHandler } = await import('./generate.js');
    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, mockRes());
    expect(resolveSpecGenerationContext).toHaveBeenCalledWith(SPEC_ID, expect.anything());
    expect(generateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ section: '09 91 00' }),
      undefined,
      { sectionNumberFormat: 'dots' }
    );
  });

  it('generate: no project default and no body format → canonical (undefined options)', async () => {
    // setupSpecGenerate's default snapshot is { null, null }.
    const { generateDocx } = await loadSpecMocks();
    const { generateHandler } = await import('./generate.js');
    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, mockRes());
    expect(generateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ section: '09 91 00' }),
      undefined,
      undefined
    );
  });

  // Regression (CodeRabbit, PR #479): the handler must resolve sole ownership
  // EXACTLY ONCE and derive both the section-number-format fallback and the
  // header/footer from that single snapshot — never two independent lookups a
  // concurrent membership change could wedge between.
  it('generate: resolves sole ownership once, feeding format and header/footer from one snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    const { generateDocx, resolveSpecGenerationContext } = await loadSpecMocks();
    vi.mocked(resolveSpecGenerationContext)
      .mockReset()
      .mockResolvedValueOnce({
        sectionNumberFormat: 'dots',
        headerFooter: { composition: COMPOSITION, fieldValues: { projectName: 'Acme HQ' } },
      });
    const { generateHandler } = await import('./generate.js');

    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, mockRes());

    expect(resolveSpecGenerationContext).toHaveBeenCalledTimes(1);
    expect(generateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ section: '09 91 00' }),
      undefined,
      {
        sectionNumberFormat: 'dots',
        headerFooter: {
          composition: COMPOSITION,
          current: { date: '2026-07-12', projectName: 'Acme HQ' },
        },
      }
    );
  });
});

async function loadSpecMocks(): Promise<{
  generateDocx: Awaited<typeof import('../generator/index.js')>['generateDocx'];
  resolveSpecGenerationContext: Awaited<
    typeof import('../db/index.js')
  >['resolveSpecGenerationContext'];
}> {
  await setupSpecGenerate();
  const { generateDocx } = await import('../generator/index.js');
  const { resolveSpecGenerationContext } = await import('../db/index.js');
  return { generateDocx, resolveSpecGenerationContext };
}

const COMPOSITION = { header: { left: { content: [] } } } as unknown as HeaderFooterComposition;

// #304 — REST wiring of buildHeaderFooterOptions into generateHandler, now fed
// by the single resolveSpecGenerationContext snapshot.
// I4: sole project with a configured header/footer -> generateDocx receives
// options.headerFooter populated from the resolved context, date-stamped.
// I6: orphan/multi-project/zero-layer -> headerFooter stays omitted, so the
// pre-#304 `options` shape (existing describe('generateHandler') block
// above) is unchanged byte-for-byte.
// I7: a resolved context that omits clientName (stale/missing
// clientLibraryId at the DB layer) never throws here — the field is simply
// absent from options.headerFooter.current.
// I9: a DatabaseError thrown while resolving the generation context surfaces
// through generateHandler's existing catch-all as a 500, not a new swallow.
describe('generateHandler — header/footer resolution (#304)', () => {
  it('I4: configured project -> generateDocx receives populated options.headerFooter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:00:00Z'));
    const { generateDocx, resolveSpecGenerationContext } = await loadSpecMocks();
    vi.mocked(resolveSpecGenerationContext)
      .mockReset()
      .mockResolvedValueOnce({
        sectionNumberFormat: null,
        headerFooter: {
          composition: COMPOSITION,
          fieldValues: { projectName: 'Acme HQ', clientName: 'Acme Corp' },
        },
      });
    const { generateHandler } = await import('./generate.js');

    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, mockRes());

    expect(resolveSpecGenerationContext).toHaveBeenCalledWith(SPEC_ID, expect.anything());
    expect(generateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ section: '09 91 00' }),
      undefined,
      expect.objectContaining({
        headerFooter: {
          composition: COMPOSITION,
          current: { date: '2026-07-12', projectName: 'Acme HQ', clientName: 'Acme Corp' },
        },
      })
    );
  });

  it('I6: no owning project/config -> options.headerFooter stays omitted', async () => {
    const { generateDocx } = await loadSpecMocks();
    const { generateHandler } = await import('./generate.js');

    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, mockRes());

    // options may be undefined outright (pre-#304 baseline) or an object
    // without headerFooter — either is the correct I6 outcome.
    const call = vi.mocked(generateDocx).mock.calls[0];
    expect(call?.[2] ?? {}).not.toHaveProperty('headerFooter');
  });

  it('I7: resolved context without clientName -> current omits clientName, no throw', async () => {
    const { generateDocx, resolveSpecGenerationContext } = await loadSpecMocks();
    vi.mocked(resolveSpecGenerationContext)
      .mockReset()
      .mockResolvedValueOnce({
        sectionNumberFormat: null,
        headerFooter: { composition: COMPOSITION, fieldValues: { projectName: 'Acme HQ' } },
      });
    const { generateHandler } = await import('./generate.js');
    const res = mockRes();

    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, res);

    expect(res.status).not.toHaveBeenCalled();
    const call = vi.mocked(generateDocx).mock.calls[0];
    const headerFooter = (
      call?.[2] as { headerFooter?: { current: Record<string, unknown> } } | undefined
    )?.headerFooter;
    expect(headerFooter?.current).toEqual(expect.objectContaining({ projectName: 'Acme HQ' }));
    expect(headerFooter?.current ?? {}).not.toHaveProperty('clientName');
  });

  it('I9: DatabaseError while resolving context surfaces as the existing 500, not swallowed', async () => {
    const { getSpecTree, getTemplateByName, resolveSpecGenerationContext } =
      await import('../db/index.js');
    const { generateDocx } = await import('../generator/index.js');
    vi.mocked(getSpecTree).mockResolvedValueOnce({
      tree: { id: SPEC_ID, section: '09 91 00', title: 'Painting', parts: [] },
      references: [],
    });
    vi.mocked(getTemplateByName).mockResolvedValueOnce(null);
    vi.mocked(resolveSpecGenerationContext).mockRejectedValueOnce(
      new DatabaseError('findSoleOwningProject: query failed')
    );
    const { generateHandler } = await import('./generate.js');
    const res = mockRes();

    await generateHandler({ params: { id: SPEC_ID }, body: {} } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'generation failed' });
    expect(generateDocx).not.toHaveBeenCalled();
  });
});

function mockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    send: vi.fn(),
  } as unknown as Response;
}

const PROJECT_ID = '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef';

describe('generateManualHandler', () => {
  it('400 on non-UUID project id', async () => {
    const { generateManualHandler } = await import('./generate.js');
    const res = mockRes();
    await generateManualHandler({ params: { id: 'nope' }, body: {} } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('404 when project not found', async () => {
    const { findProjectById } = await import('../db/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce(null);
    const { generateManualHandler } = await import('./generate.js');
    const res = mockRes();
    await generateManualHandler(
      { params: { id: PROJECT_ID }, body: {} } as unknown as Request,
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('422 when project has no sections', async () => {
    const { findProjectById } = await import('../db/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      name: 'Empty',
      description: null,
      sources: [],
      toc: [],
      deletedAt: null,
      deletedBy: null,
      sectionNumberFormat: 'canonical',
    });
    const { generateManualHandler } = await import('./generate.js');
    const res = mockRes();
    await generateManualHandler(
      { params: { id: PROJECT_ID }, body: {} } as unknown as Request,
      res
    );
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('streams a single manual buffer in TOC order', async () => {
    const { findProjectById, getSpecTree, getTemplateByName } = await import('../db/index.js');
    const { generateManual } = await import('../generator/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      name: 'Acme HQ',
      description: null,
      sources: [],
      toc: [
        {
          specId: 'aaaaaaaa-0000-4000-8000-000000000001',
          section: '03 30 00',
          title: 'A',
          position: 1,
        },
        {
          specId: 'bbbbbbbb-0000-4000-8000-000000000002',
          section: '09 91 00',
          title: 'B',
          position: 2,
        },
      ],
      deletedAt: null,
      deletedBy: null,
      sectionNumberFormat: 'canonical',
    });
    vi.mocked(getSpecTree)
      .mockResolvedValueOnce({
        tree: { id: 'a', section: '03 30 00', title: 'A', parts: [] },
        references: [],
      })
      .mockResolvedValueOnce({
        tree: { id: 'b', section: '09 91 00', title: 'B', parts: [] },
        references: [],
      });
    vi.mocked(getTemplateByName).mockResolvedValueOnce(null);
    vi.mocked(generateManual).mockResolvedValueOnce(Buffer.from('manual'));
    const { generateManualHandler } = await import('./generate.js');
    const res = mockRes();
    await generateManualHandler(
      { params: { id: PROJECT_ID }, body: {} } as unknown as Request,
      res
    );
    expect(generateManual).toHaveBeenCalledWith(
      [
        expect.objectContaining({ section: '03 30 00' }),
        expect.objectContaining({ section: '09 91 00' }),
      ],
      { name: 'Acme HQ', description: null },
      undefined,
      // Body omits the format → the project's stored "canonical" default applies.
      { sectionNumberFormat: 'canonical' }
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('manual'));
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('.docx')
    );
  });

  it('generate: falls back to the project default when body omits the format', async () => {
    const { findProjectById, getSpecTree, getTemplateByName } = await import('../db/index.js');
    const { generateManual } = await import('../generator/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      name: 'Acme HQ',
      description: null,
      sources: [],
      toc: [
        {
          specId: 'aaaaaaaa-0000-4000-8000-000000000001',
          section: '03 30 00',
          title: 'A',
          position: 1,
        },
      ],
      deletedAt: null,
      deletedBy: null,
      sectionNumberFormat: 'dots',
    });
    vi.mocked(getSpecTree).mockResolvedValueOnce({
      tree: { id: 'a', section: '03 30 00', title: 'A', parts: [] },
      references: [],
    });
    vi.mocked(getTemplateByName).mockResolvedValueOnce(null);
    vi.mocked(generateManual).mockResolvedValueOnce(Buffer.from('manual'));
    const { generateManualHandler } = await import('./generate.js');
    await generateManualHandler(
      { params: { id: PROJECT_ID }, body: {} } as unknown as Request,
      mockRes()
    );
    expect(generateManual).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), undefined, {
      sectionNumberFormat: 'dots',
    });
  });

  it('generate: request sectionNumberFormat wins over the project default', async () => {
    const { findProjectById, getSpecTree, getTemplateByName } = await import('../db/index.js');
    const { generateManual } = await import('../generator/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      name: 'Acme HQ',
      description: null,
      sources: [],
      toc: [
        {
          specId: 'aaaaaaaa-0000-4000-8000-000000000001',
          section: '03 30 00',
          title: 'A',
          position: 1,
        },
      ],
      deletedAt: null,
      deletedBy: null,
      sectionNumberFormat: 'dots',
    });
    vi.mocked(getSpecTree).mockResolvedValueOnce({
      tree: { id: 'a', section: '03 30 00', title: 'A', parts: [] },
      references: [],
    });
    vi.mocked(getTemplateByName).mockResolvedValueOnce(null);
    vi.mocked(generateManual).mockResolvedValueOnce(Buffer.from('manual'));
    const { generateManualHandler } = await import('./generate.js');
    await generateManualHandler(
      {
        params: { id: PROJECT_ID },
        body: { sectionNumberFormat: 'compact' },
      } as unknown as Request,
      mockRes()
    );
    expect(generateManual).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), undefined, {
      sectionNumberFormat: 'compact',
    });
  });
});
