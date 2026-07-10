import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptUrl = new URL('../examples/web_ui_demo/Start-SpecR.sh', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const script = readFileSync(scriptUrl, 'utf8');

// A bash harness that `source`s Start-SpecR.sh (its source-guard stops before the
// startup sequence), then stubs the process-edge commands so the readiness gate
// can be exercised in isolation:
//   - `docker compose exec … pg_isready` returns success/failure per PROBE_PATTERN
//     (a space-separated list of 1=ok / 0=fail, last value repeats when exhausted),
//   - `sleep` is a no-op counter so the loop runs instantly,
//   - `tcp_is_open` returns TCP_RC (default 0 = reachable).
// It prints machine-readable lines the test asserts on: PROBE/DOCKER call traces,
// RESULT READY|TIMEOUT, CALLS <n>, SLEEPS <n>, INIT_RC <n>.
const harness = `
set -uo pipefail
# shellcheck source=/dev/null
source "$START_SH"
set +e
set +u
CALLS=0
SLEEPS=0
read -ra PROBE_RESULTS <<< "\${PROBE_PATTERN:-1 1}"
docker() {
  if [[ "\${1:-}" == "compose" && "\${2:-}" == "exec" ]]; then
    local idx=$CALLS r
    CALLS=$((CALLS + 1))
    if (( idx < \${#PROBE_RESULTS[@]} )); then
      r="\${PROBE_RESULTS[idx]}"
    else
      r="\${PROBE_RESULTS[\${#PROBE_RESULTS[@]} - 1]}"
    fi
    # Echo the full argv so a test can assert the probe targets TCP (-h), not the
    # unix socket — a socket probe races the initdb temp server (see #405).
    printf 'EXEC %s\\n' "$*"
    printf 'PROBE %s %s\\n' "$CALLS" "$r"
    [[ "$r" == "1" ]] && return 0
    return 1
  fi
  printf 'DOCKER %s\\n' "$*"
  return 0
}
sleep() { SLEEPS=$((SLEEPS + 1)); }
tcp_is_open() { return \${TCP_RC:-0}; }
case "\${1:-confirm}" in
  confirm)
    if confirm_compose_postgres_ready "\${ATTEMPTS:-60}"; then
      printf 'RESULT READY\\n'
    else
      printf 'RESULT TIMEOUT\\n'
    fi
    printf 'CALLS %s\\n' "$CALLS"
    printf 'SLEEPS %s\\n' "$SLEEPS"
    ;;
  external)
    export DATABASE_URL="\${DATABASE_URL:-postgres://specr:specr@localhost:5599/specr}"
    DATABASE_URL_WAS_SUPPLIED=1
    if initialize_database; then
      printf 'INIT_RC 0\\n'
    else
      printf 'INIT_RC nonzero\\n'
    fi
    ;;
esac
`;

function runHarness(
  scenario: 'confirm' | 'external',
  env: Record<string, string> = {}
): { stdout: string; status: number | null } {
  const result = spawnSync('/usr/bin/bash', ['-c', harness, 'harness', scenario], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, START_SH: scriptPath, ...env },
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

function callCount(stdout: string): number {
  const match = /^CALLS (\d+)$/m.exec(stdout);
  return match ? Number(match[1]) : -1;
}

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
    const result = spawnSync('/usr/bin/bash', ['-n', scriptPath], { encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  // Regression for #405: the TCP gate passes as soon as docker-proxy publishes the
  // port, before postgres finishes its fresh-volume initdb restart, so `pnpm migrate`
  // hit the transient server and died with "Connection terminated unexpectedly".
  it('regression: readiness gate waits through failed pg_isready probes and needs two consecutive OKs', () => {
    const { stdout } = runHarness('confirm', { PROBE_PATTERN: '0 0 1 1' });

    // fail, fail, ok(streak 1), ok(streak 2) → success only on the 4th probe:
    // proves the loop waited past the failures AND that one lone success is not enough.
    expect(stdout).toContain('RESULT READY');
    expect(callCount(stdout)).toBe(4);
    // It slept between probes rather than busy-returning.
    expect(stdout).toMatch(/^SLEEPS ([1-9]\d*)$/m);
  });

  it('regression: pg_isready probes the TCP path (-h 127.0.0.1 -p 5432), not the unix socket', () => {
    // A socket probe (no -h) succeeds against the initdb temp server, which listens
    // on the socket only (listen_addresses=''), so it would re-open the very race
    // #405 fixes. The probe must hit TCP — the same path pnpm migrate connects over.
    const { stdout } = runHarness('confirm', { PROBE_PATTERN: '1 1' });

    const execLine = /^EXEC .*$/m.exec(stdout)?.[0] ?? '';
    expect(execLine).toContain('pg_isready');
    expect(execLine).toContain('-h 127.0.0.1');
    expect(execLine).toContain('-p 5432');
  });

  it('regression: readiness gate returns non-zero if pg_isready never succeeds within the budget', () => {
    const { stdout } = runHarness('confirm', { PROBE_PATTERN: '0', ATTEMPTS: '5' });

    expect(stdout).toContain('RESULT TIMEOUT');
    expect(stdout).not.toContain('RESULT READY');
    expect(callCount(stdout)).toBe(5);
  });

  it('regression: readiness streak resets when a probe fails between successes', () => {
    // ok, fail, ok, ok → the leading lone success must not count toward the pair;
    // success only after the final two consecutive OKs (4th probe).
    const { stdout } = runHarness('confirm', { PROBE_PATTERN: '1 0 1 1' });

    expect(stdout).toContain('RESULT READY');
    expect(callCount(stdout)).toBe(4);
  });

  it('regression: external DATABASE_URL is confirmed via TCP only, never docker compose exec', () => {
    const { stdout } = runHarness('external', {
      DATABASE_URL: 'postgres://specr:specr@localhost:5599/specr',
      TCP_RC: '0',
    });

    expect(stdout).toContain('INIT_RC 0');
    expect(stdout).not.toContain('PROBE');
    expect(stdout).not.toContain('DOCKER');
  });
});
