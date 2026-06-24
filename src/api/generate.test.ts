import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getSpecTree: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateByName: vi.fn(),
  findProjectById: vi.fn(),
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

describe('generateHandler', () => {
  it('passes sectionNumberFormat to generateDocx', async () => {
    const { getSpecTree, getTemplateByName } = await import('../db/index.js');
    const { generateDocx } = await import('../generator/index.js');
    vi.mocked(getSpecTree).mockResolvedValueOnce({
      tree: {
        id: '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef',
        section: '09 91 00',
        title: 'Painting',
        parts: [],
      },
      references: [],
    });
    vi.mocked(getTemplateByName).mockResolvedValueOnce(null);
    vi.mocked(generateDocx).mockResolvedValueOnce(Buffer.from('docx'));
    const { generateHandler } = await import('./generate.js');
    const req = {
      params: { id: '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef' },
      body: { sectionNumberFormat: 'dots' },
    } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      send: vi.fn(),
    } as unknown as Response;
    await generateHandler(req, res);
    expect(generateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ section: '09 91 00' }),
      undefined,
      { sectionNumberFormat: 'dots' }
    );
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
      undefined
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('manual'));
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('.docx')
    );
  });
});
