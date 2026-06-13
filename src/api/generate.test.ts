import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getSpecTree: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateByName: vi.fn(),
}));
vi.mock('../generator/index.js', () => ({
  generateDocx: vi.fn(),
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
