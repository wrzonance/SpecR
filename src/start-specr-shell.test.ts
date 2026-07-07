import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scriptPath = new URL('../examples/web_ui_demo/Start-SpecR.sh', import.meta.url);
const script = readFileSync(scriptPath, 'utf8');

describe('examples/web_ui_demo/Start-SpecR.sh', () => {
  it('regression: ambient pnpm 10 is replaced before repo install', () => {
    const ensureCall = script.indexOf('\nensure_pnpm\n');
    const installCall = script.indexOf('\nrun_pnpm install --frozen-lockfile\n');

    expect(script).toContain('PNPM_REQUIRED_VERSION="11.0.0"');
    expect(script).toContain('corepack install -g "pnpm@$PNPM_REQUIRED_VERSION"');
    expect(script).toContain('PNPM_COMMAND=(corepack pnpm)');
    expect(ensureCall).toBeGreaterThan(-1);
    expect(installCall).toBeGreaterThan(ensureCall);
  });

  it('regression: unreachable default Postgres is handled before migrations', () => {
    const initCall = script.indexOf('\ninitialize_database\n');
    const migrateCall = script.indexOf('\nrun_pnpm migrate\n');

    expect(script).toContain('DATABASE_URL_WAS_SUPPLIED=');
    expect(script).toContain('docker compose up -d --force-recreate postgres');
    expect(script).toContain('SPECR_DB_HOST_PORT="$port"');
    expect(script).toContain('docker compose version');
    expect(script).toContain(
      'port="$(find_free_port "${SPECR_DB_HOST_PORT:-5432}" "$API_PORT" "$WEB_PORT")"'
    );
    expect(script).toContain(
      'DATABASE_URL="postgres://specr:specr@localhost:$DOCKER_DATABASE_PORT/specr"'
    );
    expect(initCall).toBeGreaterThan(-1);
    expect(migrateCall).toBeGreaterThan(initCall);
  });

  it('is valid bash syntax', () => {
    const result = spawnSync('/usr/bin/bash', ['-n', scriptPath.pathname], { encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
