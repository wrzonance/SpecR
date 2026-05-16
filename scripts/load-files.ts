import { glob } from 'node:fs/promises';
import path from 'node:path';
import { loadFiles } from '../src/lib/file-loader.js';
import { pool } from '../src/db/index.js';

const PROJECT_ROOT = process.cwd();

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm load:files <glob-or-path> [...]');
    return 1;
  }

  const allFiles: string[] = [];
  for (const arg of args) {
    const matches = await Array.fromAsync(glob(arg, { cwd: PROJECT_ROOT }));
    if (matches.length > 0) {
      allFiles.push(...matches.map((m) => path.join(PROJECT_ROOT, m)));
    } else {
      allFiles.push(path.resolve(arg));
    }
  }

  if (allFiles.length === 0) {
    console.log('No files matched — nothing to load.');
    return 0;
  }

  console.log(`Loading ${allFiles.length} file(s)...`);
  let done = 0;

  const result = await loadFiles(allFiles, {
    onProgress: (_done, total, file, ok) => {
      done++;
      const rel = path.relative(PROJECT_ROOT, file);
      process.stdout.write(`${ok ? '✓' : '✗'} [${done}/${total}] ${rel}\n`);
    },
  });

  console.log(
    `\nResults: ${result.succeeded} succeeded, ${result.failed} failed of ${result.total} total`
  );

  if (result.errors.length > 0) {
    const shown = result.errors.slice(0, 20);
    console.error('\nErrors:');
    for (const e of shown) {
      console.error(`  ${path.relative(PROJECT_ROOT, e.file)}: ${e.error}`);
    }
    if (result.errors.length > 20) {
      console.error(`  ...and ${result.errors.length - 20} more`);
    }
  }

  return result.failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error('Fatal:', err);
    await pool.end();
    process.exit(1);
  });
