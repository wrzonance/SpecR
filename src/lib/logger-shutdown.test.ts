import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it.each(['immediate', 'concurrent'])(
  'logger: %s file shutdown resolves, can repeat, and retains the final line',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'specr-logger-shutdown-'));
    try {
      const script = `
        const { logger, closeLogger } = await import('./src/lib/logger.ts');
        logger.info('final shutdown regression line');
        ${mode === 'concurrent' ? 'await Promise.all([closeLogger(), closeLogger()]);' : 'await closeLogger();'}
        await closeLogger();
        process.stdout.write('shutdown completed');
      `;
      const result = await run(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          env: {
            ...process.env,
            NODE_ENV: 'production',
            DATABASE_URL: 'postgres://test:test@localhost:5432/test',
            LOG_LEVEL: 'info',
            LOG_TO_FILE: 'true',
            LOG_DIR: directory,
          },
          timeout: 10_000,
        }
      );
      expect(result.stdout).toContain('shutdown completed');
      const files = await readdir(directory);
      expect(files.length).toBeGreaterThan(0);
      const contents = await Promise.all(
        files.map((file) => readFile(join(directory, file), 'utf8'))
      );
      expect(contents.join('')).toContain('final shutdown regression line');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000
);
