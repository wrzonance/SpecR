import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './index.js';

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
