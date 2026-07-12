import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, tierForIlvl } from './index.js';
import { tierForIlvl as astTierForIlvl } from '../ast/index.js';

describe('parse() dispatcher', () => {
  it('dispatches .txt to text parser', async () => {
    const buf = readFileSync(join('tests', 'fixtures', 'text', 'numbered-prefixes.txt'));
    const result = await parse(buf, 'numbered-prefixes.txt');
    expect(result.tree.parts.length).toBeGreaterThan(0);
    expect(result.capabilities).toContain('read-only');
  });

  it('throws ParserError for unsupported extension', async () => {
    await expect(parse(Buffer.from(''), 'file.xyz')).rejects.toThrow('unsupported format');
  });
});

describe('tierForIlvl re-export', () => {
  it('re-exports the exact AST source of truth (no shadow copy in the parser)', () => {
    expect(tierForIlvl).toBe(astTierForIlvl);
  });

  it('bands ilvl relative to articleIlvl', () => {
    expect(tierForIlvl(0, 1)).toBe('part');
    expect(tierForIlvl(1, 1)).toBe('article');
    expect(tierForIlvl(2, 1)).toBe('paragraph');
    expect(tierForIlvl(3, 1)).toBe('subparagraph');
  });
});
