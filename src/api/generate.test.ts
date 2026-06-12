import { describe, it, expect, vi } from 'vitest';

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
