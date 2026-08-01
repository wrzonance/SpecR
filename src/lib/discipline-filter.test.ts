import { describe, it, expect } from 'vitest';
import { DisciplineFilter } from './discipline-filter.js';

function normalize(input: unknown): string | undefined {
  const parsed = DisciplineFilter.safeParse(input);
  if (!parsed.success) throw new Error('expected the value to parse');
  return parsed.data;
}

describe('DisciplineFilter', () => {
  it('treats an empty string as absent', () => {
    expect(normalize('')).toBeUndefined();
  });

  it('treats a whitespace-only string as absent', () => {
    expect(normalize('   ')).toBeUndefined();
    expect(normalize('\t\n ')).toBeUndefined();
  });

  it('passes undefined through unchanged', () => {
    expect(normalize(undefined)).toBeUndefined();
  });

  it('returns a non-blank value trimmed', () => {
    expect(normalize('electrical')).toBe('electrical');
    expect(normalize('  electrical  ')).toBe('electrical');
  });

  it('still rejects a non-scalar value so the repeated-param 400 survives', () => {
    expect(DisciplineFilter.safeParse(['electrical', 'hvac']).success).toBe(false);
  });
});
