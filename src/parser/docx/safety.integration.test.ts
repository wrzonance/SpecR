import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertDocxSafe } from './safety.js';

const FIXTURE_DIRS = [
  path.resolve('docs/references/ARCAT'),
  path.resolve('docs/references/MANUFACTURER_CPI'),
];

async function collectDocxFixtures(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of FIXTURE_DIRS) {
    try {
      await stat(dir);
    } catch {
      continue;
    }
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.docx')) {
        found.push(path.join(dir, entry));
      }
    }
  }
  return found;
}

describe('assertDocxSafe — corpus validation', () => {
  it('all fixture .docx files pass structural safety check', async () => {
    const fixtures = await collectDocxFixtures();
    if (fixtures.length === 0) {
      console.warn('No .docx fixtures found — skipping corpus test');
      return;
    }

    const results: Array<{ file: string; error: string }> = [];
    let skipped = 0;
    for (const filePath of fixtures) {
      const buf = await readFile(filePath);
      // 11_53_00nle.docx is a Git LFS stub (ASCII error text, not a real DOCX).
      // Skip any file that lacks the PK zip magic bytes — it is not a real DOCX fixture.
      if (buf.length < 4 || buf.readUInt32BE(0) !== 0x504b0304) {
        console.warn(`Skipping non-DOCX file: ${path.relative(process.cwd(), filePath)}`);
        skipped++;
        continue;
      }
      try {
        await assertDocxSafe(buf);
      } catch (err) {
        results.push({
          file: path.relative(process.cwd(), filePath),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (results.length > 0) {
      const detail = results.map((r) => `  ${r.file}: ${r.error}`).join('\n');
      throw new Error(
        `${results.length}/${fixtures.length} fixtures failed assertDocxSafe:\n${detail}`
      );
    }

    const passed = fixtures.length - skipped;
    console.info(`assertDocxSafe: ${passed} fixtures passed, ${skipped} skipped (non-DOCX stubs)`);
    expect(passed).toBeGreaterThan(0);
  });
});
