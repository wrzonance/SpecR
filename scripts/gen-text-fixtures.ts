import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function stripXml(raw: string): string {
  return raw
    .split('<')
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf('>') + 1)))
    .join(' ')
    .split(/\n|\r\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

mkdirSync(join('tests', 'fixtures', 'text'), { recursive: true });

const sec = readFileSync(join('tests', 'fixtures', 'sec', '27_10_00.SEC'), 'utf-8');
writeFileSync(join('tests', 'fixtures', 'text', 'ufgs-27-10-00.txt'), stripXml(sec));
console.log('Generated: tests/fixtures/text/ufgs-27-10-00.txt');
