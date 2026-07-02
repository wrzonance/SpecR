# ADR-046: Configurable, runtime-mutable rate limiting (env-seeded)

## Status

Accepted.

## Context

SpecR runs two `express-rate-limit` limiters:

- **REST `parseRateLimit`** (`src/api/router.ts`) — guards the four multipart
  upload routes (`POST /parse`, `/templates/import`, `/libraries/:id/import`,
  `/numbering-profiles/snapshot`).
- **MCP `mcpRateLimit`** (`src/mcp/server.ts`) — guards `POST /mcp`.

Both were **hardcoded**: `windowMs: 60_000`, REST `max: 10`, MCP `max: 20`
(`DEFAULT_MCP_RATE_LIMIT_MAX`). Changing a limit meant editing source and
redeploying, and there was no way to turn limiting off. Two concrete needs
surfaced:

1. **The web UI demo** (`examples/web_ui_demo/`) trips these quotas immediately
   — loading several sections or chatting through the MCP bridge exceeds 10
   uploads / 20 MCP calls per minute — which makes the demo feel broken.
2. **A future admin surface** (e.g. a settings page in the demo) should be able
   to tweak the limits or toggle limiting **at runtime**, without a restart.

An earlier draft proposed `Object.freeze(config)` to make the limits a strictly
immutable startup snapshot. That was rejected: it fights need (2). If something
in-process legitimately changes a limit later, we want to honour it, not throw.

## Decision

**Seed the limits from the environment at boot; read them live per request.**

1. Four new env vars, validated in `src/lib/env.ts` with the existing Zod
   patterns (`z.stringbool`, `z.coerce.number().int().positive()`):
   - `DISABLE_RATE_LIMIT` (default `false`) — master off switch.
   - `RATE_LIMIT_UPLOAD_MAX` (default `10`), `RATE_LIMIT_MCP_MAX` (default `20`),
     `RATE_LIMIT_WINDOW_MS` (default `60000`).

2. Both limiters read `config` through **per-request closures** so a runtime
   mutation of `config.*` takes effect on the very next request:
   - `limit: () => config.RATE_LIMIT_UPLOAD_MAX` (MCP: `() => options?.rateLimitMax ?? config.RATE_LIMIT_MCP_MAX`)
   - `skip: () => …DISABLE_RATE_LIMIT` (see asymmetry below)

   `express-rate-limit` evaluates `limit` and `skip` on every request, so this is
   free — no extra machinery. The **one** value it bakes in at construction is
   `windowMs`; changing the window therefore still requires a restart. That is an
   accepted trade-off (windows are rarely retuned) and is documented, not worked
   around.

3. **`config` is intentionally not frozen.** It remains a parse-once singleton
   (ESM-cached), but a future admin surface may mutate `config.DISABLE_RATE_LIMIT`
   / `config.RATE_LIMIT_*` and have it honoured live.

4. **Secure by default.** Schema and root `.env.example` default to limiting
   **on**. Only the web UI demo opts out: `examples/web_ui_demo/.env.example`
   ships `DISABLE_RATE_LIMIT=true`, and the one-command launchers
   (`Start-SpecR.sh` / `.ps1`) start the API with two `node --env-file-if-exists`
   flags — the committed `.env.example` first (so the opt-out applies on a clean
   checkout, where the gitignored `.env` does not exist), then a user's real
   `.env` which overrides it. Node's `--env-file` does **not** override
   already-exported vars, so the launcher's `PORT`/`DATABASE_URL`/`NODE_ENV`
   still win and the demo's `PORT=3001` cannot clobber the API's port; the files
   only supply keys the launcher did not export (i.e. `DISABLE_RATE_LIMIT`).

### Skip-mode asymmetry (preserved)

- REST: `skip: () => config.NODE_ENV === 'test' || config.DISABLE_RATE_LIMIT`
- MCP: `skip: () => config.DISABLE_RATE_LIMIT` (no test-mode skip)

The MCP limiter deliberately stays active under `NODE_ENV=test` so
`server.rate-limit.test.ts` can exercise it end to end; integration suites raise
the ceiling via the existing `registerMcpRoutes(app, { rateLimitMax })` seam
rather than disabling it. This matches the pre-existing behaviour and is left
unchanged to keep the diff scoped to the feature.

## Consequences

- Operators can retune or disable rate limiting via env without a code change;
  the demo is unlimited out of the box while production stays protected.
- A future admin UI can flip the toggle or adjust the ceilings at runtime and see
  it apply on the next request — no restart — because the limiters read `config`
  live. (Only the rolling window needs a restart to change.)
- `config` is not deeply immutable; callers must treat it as the single source of
  truth and mutate it through a deliberate API (the future admin surface), never
  ad hoc.
- The OpenAPI descriptions on the affected routes now state the numbers as the
  configurable default rather than a fixed value.
- The `rateLimitMax` option on `registerMcpRoutes` is retained as a runtime
  override that wins over the configured default (used by integration tests).
