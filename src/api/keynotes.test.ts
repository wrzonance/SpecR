import { describe, it, expect, vi } from 'vitest';
import { renderKeynoteTable, keynotesFilename } from './keynotes.js';

// The pure renderer + filename helpers need no DB; mocking the barrel keeps this
// a unit test (importing the real db/index.js would load env.ts and demand a
// DATABASE_URL). Mirrors generate.test.ts.
vi.mock('../db/index.js', () => ({
  findProjectById: vi.fn(),
  getProjectKeynotes: vi.fn(),
  pool: {},
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// A row shaped like the getProjectKeynotes result, trimmed to the three columns
// the Revit keynote table renders. The DB query fixes ordering (ORDER BY code),
// so the renderer is a pure, order-preserving projection.
type Row = Parameters<typeof renderKeynoteTable>[0][number];
function row(code: string, description: string, parentCode: string | null): Row {
  return { code, description, parentCode };
}

describe('renderKeynoteTable', () => {
  it('keynotes: deterministic fixture renders the exact tab-delimited body with hierarchy preserved', () => {
    const body = renderKeynoteTable([
      row('A', 'Acoustical ceiling', null),
      row('A1', 'Suspended panel', 'A'),
      row('B', 'Interior paint', null),
    ]);
    // Top-level rows are two columns (no parent); child rows carry the parent as
    // a third column. Every row is newline-terminated so the file ends in \n.
    expect(body).toBe('A\tAcoustical ceiling\nA1\tSuspended panel\tA\nB\tInterior paint\n');
  });

  it('keynotes: an empty keynote set renders an empty body', () => {
    expect(renderKeynoteTable([])).toBe('');
  });

  it('keynotes: a blank or whitespace parent code is treated as top-level (no trailing tab)', () => {
    // parent_code has no non-empty DB constraint, so a stored '' must not emit a
    // dangling third column that Revit would read as a zero-length parent key.
    expect(renderKeynoteTable([row('C', 'Sealant', '')])).toBe('C\tSealant\n');
    expect(renderKeynoteTable([row('D', 'Grout', '   ')])).toBe('D\tGrout\n');
  });

  it('keynotes: tabs and newlines inside a field collapse to a space so the row/column grid holds', () => {
    const body = renderKeynoteTable([row('E', 'Line one\nLine two\tclause', 'E\tparent')]);
    expect(body).toBe('E\tLine one Line two clause\tE parent\n');
  });
});

describe('keynotesFilename', () => {
  it('keynotes: spaces become dashes and the -keynotes.txt suffix is appended', () => {
    expect(keynotesFilename('Acme HQ Renovation')).toBe('Acme-HQ-Renovation-keynotes.txt');
  });

  it('keynotes: empty / symbol-only name falls back to "project"', () => {
    expect(keynotesFilename('')).toBe('project-keynotes.txt');
    expect(keynotesFilename('@@@')).toBe('project-keynotes.txt');
  });
});
