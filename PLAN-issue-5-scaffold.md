# Plan: Issue #5 — Project Scaffold

**Goal:** Server starts, connects to PostgreSQL, responds to `GET /health`. CI passes.
**Branch:** `feat/foundation-scaffold`
**Issue:** https://github.com/wrzonance/SpecR/issues/5

---

## Phase 0: Documentation Discovery (Complete)

All findings are sourced. Exact versions and APIs confirmed against npm registry and official docs as of 2026-05-07.

### Verified Package Versions

| Package | Version | Notes |
|---------|---------|-------|
| `express` | 5.2.1 | `latest` tag now resolves to v5 |
| `@types/express` | 5.0.6 | |
| `zod` | 4.4.3 | **v4 — breaking import change from v3** |
| `pg` | 8.20.0 | |
| `@types/pg` | 8.20.0 | Separate install required |
| `pino` | 10.3.1 | Ships own TypeScript types |
| `pino-pretty` | 13.1.3 | devDep, dev-only transport |
| `uuid` | 11.x | |
| `typescript` | 5.9.x | New `--module node20` option |
| `@types/node` | ^22.x.x | Pin to Node 22 major |
| `tsx` | 4.21.0 | Replaces ts-node-dev (dead project) |
| `vitest` | 4.1.5 | Requires Vite 8 |
| `@vitest/coverage-v8` | 4.x | Separate install |
| `eslint` | 9.x | Flat config (`eslint.config.js`) |
| `typescript-eslint` | 8.59.2 | Unified package, replaces separate `@typescript-eslint/*` |
| `@eslint/js` | latest | ESLint core JS rules |
| `eslint-plugin-sonarjs` | 4.0.3 | Full ESLint 9 flat config support |
| `eslint-config-prettier` | 10.1.8 | Still needed; use `/flat` import |
| `prettier` | 3.x | |
| `pnpm` | 11.x | Node 22+ required |

### Verified API Signatures

**Express 5:**
```typescript
import express, { Request, Response, ErrorRequestHandler } from 'express'
// Async handlers: Express 5 auto-forwards thrown errors to error middleware
// Error middleware signature unchanged (4 args):
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => { ... }
// Must be registered LAST
app.use(errorHandler)
```

**pg Pool:**
```typescript
import { Pool } from 'pg'
const pool = new Pool({ connectionString: config.DATABASE_URL })
await pool.query('SELECT 1')   // health ping
await pool.end()               // graceful shutdown
// pg does NOT auto-read DATABASE_URL — must pass via connectionString
```

**Zod v4 (BREAKING — different from v3):**
```typescript
import * as z from 'zod'                       // v4: namespace import
// NOT: import { z } from 'zod'               // v3 style — WRONG in v4
const schema = z.object({
  PORT: z.coerce.number().default(3000),       // coerce string → number
  DATABASE_URL: z.string(),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.string().default('info'),
})
const result = schema.safeParse(process.env)
if (!result.success) {
  console.error(result.error.format())
  process.exit(1)
}
export const config = result.data
```

**pino:**
```typescript
import pino from 'pino'   // requires esModuleInterop: true
const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
})
// pino-pretty runs in worker thread — never include in production config
```

**TypeScript + NodeNext (CRITICAL):**
- All relative imports in `.ts` files must use `.js` extension:
  ```typescript
  import { config } from './env.js'    // CORRECT (even though file is env.ts)
  import { config } from './env'       // WRONG — fails tsc with NodeNext
  ```
- `verbatimModuleSyntax: true` requires `import type` for type-only imports
- `"type": "module"` in package.json (pnpm 11 default)

**ESLint 9 flat config:**
```javascript
// eslint.config.js (NOT .eslintrc.json)
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
// Use unified `typescript-eslint` package — NOT @typescript-eslint/eslint-plugin + parser separately
// sonarjs.configs.recommended for flat config
// eslintConfigPrettier MUST be last
```

**Vitest 4:**
```typescript
// vitest.config.ts — use `projects` array (not deprecated vitest.workspace.ts)
// @vitest/coverage-v8 separate install required
// coverage.enabled: false in config; enable per-run via --coverage flag
```

### Anti-Patterns — Do NOT Use

- `import { z } from 'zod'` — this is v3 style, broken in v4
- `import { ts-node-dev }` or ts-node — dead projects, use tsx
- `.eslintrc.json` — ESLint 8 format, wrong for ESLint 9
- `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` separately — use unified `typescript-eslint`
- `vitest.workspace.ts` — deprecated since Vitest 3.2, use `projects` array
- `PNPM_VERSION: "9"` in CI — pnpm is now v11
- Relative imports without `.js` extension — fails TypeScript NodeNext resolution
- `pino-pretty` transport without `NODE_ENV === 'development'` guard
- `process.env.DATABASE_URL` passed directly to `new Pool()` — must use `connectionString:` key
- `import.meta.dirname` only works Node 20.11+ (fine, we target Node 22)

### CI Workflow Correction

The existing `.github/workflows/ci.yml` uses `PNPM_VERSION: "9"`. Update to `"11"` in this PR since the project will use pnpm 11. Also update `release.yml`.

---

## Phase 1: Config Files

**Branch off main:** `git checkout -b feat/foundation-scaffold`

**Outcome:** All config files present, `pnpm install` succeeds, `pnpm build` produces output (even if no src/ files yet — ok to add empty `src/index.ts` placeholder).

### 1.1 — `package.json`

```json
{
  "name": "specr",
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=11.0.0"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "lint": "eslint src/ && tsc --noEmit && prettier --check src/",
    "format": "prettier --write src/",
    "format:check": "prettier --check src/",
    "test": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:watch": "vitest --project unit",
    "migrate": "node --import tsx/esm src/db/migrate.ts",
    "migrate:down": "node --import tsx/esm src/db/migrate.ts down"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^5.2.1",
    "fast-xml-parser": "^5.0.0",
    "jszip": "^3.10.0",
    "multer": "^1.4.5",
    "pg": "^8.20.0",
    "pino": "^10.3.1",
    "uuid": "^11.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "latest",
    "@types/express": "^5.0.6",
    "@types/multer": "^1.0.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.20.0",
    "@types/uuid": "^10.0.0",
    "@vitest/coverage-v8": "^4.1.5",
    "depcheck": "^1.0.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-sonarjs": "^4.0.3",
    "pino-pretty": "^13.1.3",
    "prettier": "^3.0.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.0",
    "typescript-eslint": "^8.59.2",
    "vitest": "^4.1.5"
  }
}
```

### 1.2 — `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 1.3 — `eslint.config.js`

```javascript
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  sonarjs.configs.recommended,
  {
    rules: {
      complexity: ['error', 10],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'sonarjs/cognitive-complexity': ['error', 10],
    },
  },
  eslintConfigPrettier,
)
```

### 1.4 — `.prettierrc`

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "tabWidth": 2,
  "printWidth": 100
}
```

### 1.5 — `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      enabled: false,
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'json'],
      thresholds: { lines: 80, functions: 80, branches: 80 },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
```

### 1.6 — `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: specr
      POSTGRES_PASSWORD: specr
      POSTGRES_DB: specr
    ports:
      - "5432:5432"
    volumes:
      - specr_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U specr"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  specr_pgdata:
```

### 1.7 — `.env.example`

```
PORT=3000
DATABASE_URL=postgres://specr:specr@localhost:5432/specr
NODE_ENV=development
LOG_LEVEL=info
```

### 1.8 — Update CI workflows

In `.github/workflows/ci.yml` and `release.yml`, change:
```yaml
PNPM_VERSION: "9"
```
to:
```yaml
PNPM_VERSION: "11"
```

### Phase 1 Verification

```bash
pnpm install          # succeeds, generates pnpm-lock.yaml
pnpm build            # ok even with empty src/ (just needs tsconfig present)
```

---

## Phase 2: lib/ Modules (TDD — write tests first)

**Files:** `src/lib/errors.ts`, `src/lib/env.ts`, `src/lib/logger.ts`

**Test first, then implement.**

### 2.1 — `src/lib/errors.ts`

No test needed (trivial class extension). Implement directly.

```typescript
// src/lib/errors.ts
export class SpecrError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = this.constructor.name
  }
}
```

### 2.2 — `src/lib/env.ts` (write test first)

**Test file:** `src/lib/env.test.ts`

Test cases (RED first):
1. Valid env → returns typed config object with correct values
2. Missing `DATABASE_URL` → `process.exit(1)` called
3. Missing `NODE_ENV` → `process.exit(1)` called
4. `PORT` as string `"3000"` → coerced to number `3000`
5. Missing `LOG_LEVEL` → defaults to `"info"`
6. Missing `PORT` → defaults to `3000`

Test pattern — mock `process.exit` and capture calls:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Import the module factory, not the default export,
// so each test can reload with different env vars
describe('env validation', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  it('exits when DATABASE_URL is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
    process.env = { NODE_ENV: 'test', DATABASE_URL: '' }
    await expect(import('./env.js')).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
  // etc.
})
```

**Implementation after tests pass:**
```typescript
// src/lib/env.ts
import * as z from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.string().default('info'),
})

const result = schema.safeParse(process.env)
if (!result.success) {
  console.error('Invalid environment variables:')
  console.error(result.error.format())
  process.exit(1)
}

export const config = result.data
export type Config = typeof result.data
```

### 2.3 — `src/lib/logger.ts`

Test cases:
1. Logger has `info`, `error`, `debug`, `warn` methods
2. Logger level matches `config.LOG_LEVEL`

```typescript
// src/lib/logger.ts
import pino from 'pino'
import { config } from './env.js'

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty' },
  }),
})
```

### Phase 2 Verification

```bash
pnpm test             # lib/env.test.ts passes
pnpm build            # lib/ compiles clean
```

---

## Phase 3: Database Module (TDD)

**File:** `src/db/index.ts`

### Test file: `src/db/index.test.ts`

Unit tests (mock `pg` Pool):
1. `createPool()` creates a Pool with `connectionString` from `config.DATABASE_URL`
2. `pingDatabase(pool)` calls `pool.query('SELECT 1')`
3. `pingDatabase(pool)` throws `DatabaseError` when query fails

```typescript
// src/db/index.ts
import { Pool } from 'pg'
import { config } from '../lib/env.js'
import { SpecrError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

export class DatabaseError extends SpecrError {}

export function createPool(): Pool {
  return new Pool({ connectionString: config.DATABASE_URL })
}

export async function pingDatabase(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1')
  } catch (err) {
    throw new DatabaseError('database ping failed', { cause: err })
  }
}

export const pool = createPool()

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error')
})
```

### Phase 3 Verification

```bash
pnpm test             # db/index.test.ts passes (mocked pg)
pnpm build            # db/ compiles clean
```

---

## Phase 4: API Layer + Entry Point (TDD)

**Files:** `src/api/health.ts`, `src/api/router.ts`, `src/index.ts`

### 4.1 — Test file: `src/api/health.test.ts`

Test cases:
1. Returns 200 + `{ success: true, data: { db: 'connected', uptime: <number> } }` when `pingDatabase` resolves
2. Returns 503 + `{ success: false, error: 'database unavailable' }` when `pingDatabase` throws
3. `uptime` is a non-negative number

Mock `pingDatabase` — do not hit real DB in unit tests.

```typescript
// src/api/health.ts
import type { Request, Response } from 'express'
import { pingDatabase, pool } from '../db/index.js'
import { logger } from '../lib/logger.js'

export async function healthHandler(_req: Request, res: Response): Promise<void> {
  try {
    await pingDatabase(pool)
    res.status(200).json({
      success: true,
      data: { db: 'connected', uptime: Math.floor(process.uptime()) },
    })
  } catch (err) {
    logger.error({ err }, 'health check failed')
    res.status(503).json({ success: false, error: 'database unavailable' })
  }
}
```

### 4.2 — `src/api/router.ts`

```typescript
// src/api/router.ts
import { Router } from 'express'
import { healthHandler } from './health.js'

export const router = Router()

router.get('/health', healthHandler)
```

### 4.3 — `src/api/middleware/error.ts`

```typescript
// src/api/middleware/error.ts
import type { ErrorRequestHandler } from 'express'
import { logger } from '../../lib/logger.js'

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error({ err }, 'unhandled error')
  const status: number = (err as { status?: number }).status ?? 500
  res.status(status).json({ success: false, error: 'internal server error' })
}
```

### 4.4 — `src/index.ts`

```typescript
// src/index.ts
import express from 'express'
import { config } from './lib/env.js'
import { logger } from './lib/logger.js'
import { pool } from './db/index.js'
import { router } from './api/router.js'
import { errorHandler } from './api/middleware/error.js'

const app = express()
app.use(express.json())
app.use(router)
app.use(errorHandler)   // must be last

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'specr started')
})

async function shutdown(): Promise<void> {
  logger.info('shutdown signal received')
  server.close()
  await pool.end()
  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

### Phase 4 Verification

```bash
pnpm test             # api/health.test.ts passes
pnpm build            # full compilation succeeds
```

---

## Phase 5: Integration Test

**File:** `src/api/health.integration.test.ts`

Requires real PostgreSQL (docker-compose). Tests the full stack end-to-end.

```typescript
// Uses the running Express server + real pg pool
// Test 1: GET /health → 200 when DB is up
// Test 2: Starts server on a random port, makes real HTTP call
```

Pattern: use `app.listen(0)` (random port) in test setup, close in teardown.

### Phase 5 Verification

```bash
docker compose up -d postgres
DATABASE_URL=postgres://specr:specr@localhost:5432/specr \
  NODE_ENV=test \
  pnpm test:integration   # passes against real DB
```

---

## Phase 6: Final Verification (Full End-to-End)

Run in order. All must pass before opening PR.

```bash
# 1. From clean state
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm dev &
DEV_PID=$!

# 2. Health endpoint happy path
curl -s http://localhost:3000/health | jq
# Expected: {"success":true,"data":{"db":"connected","uptime":<n>}}

# 3. Health endpoint DB down
docker compose stop postgres
sleep 1
curl -si http://localhost:3000/health | head -1
# Expected: HTTP/1.1 503
docker compose start postgres

# 4. Bad env → server refuses to start
kill $DEV_PID
DATABASE_URL="" NODE_ENV=development pnpm dev 2>&1 | head -5
# Expected: Zod validation error logged, process exits

# 5. Lint (all three checks)
pnpm lint
# Expected: zero warnings, zero errors

# 6. Tests
pnpm test             # unit tests
pnpm test:integration # integration tests (needs DB up)

# 7. Coverage
pnpm test -- --coverage
# Expected: lib/env.ts and api/health.ts at ≥ 80% lines

# 8. Build
pnpm build
# Expected: dist/ created, zero tsc errors

# 9. Production binary
NODE_ENV=production DATABASE_URL=postgres://specr:specr@localhost:5432/specr \
  node dist/index.js &
curl -s http://localhost:3000/health | jq
# Expected: same 200 response
kill %2
```

### PR Checklist Before Opening

- [ ] All Phase 6 commands pass
- [ ] `pnpm-lock.yaml` committed
- [ ] `.env.example` committed, `.env` in `.gitignore`
- [ ] CI workflows updated: `PNPM_VERSION: "11"`
- [ ] LOC delta ≤ 500 (run `git diff --stat main...HEAD -- ':!pnpm-lock.yaml'`)
- [ ] PR description includes test plan from Issue #5

---

## Notes for Executing Agent

1. **Always use `.js` extensions on relative imports** — TypeScript NodeNext requires this even though files are `.ts`. Every `import from './foo'` must be `import from './foo.js'`.
2. **Zod v4 import** is `import * as z from 'zod'` — the `{ z }` named export no longer exists in v4.
3. **pino-pretty guard** — only include the `transport` config when `NODE_ENV === 'development'`. Never include it in production builds.
4. **pg Pool** — `connectionString` key is required. pg does not read `DATABASE_URL` automatically.
5. **Run `pnpm test` (RED) before implementing each module** to confirm tests fail for the right reasons before writing implementation.
6. **`src/db/migrate.ts` is out of scope** — stub the `migrate` script to log "not implemented yet" and exit 0. Full migrations are Issue #6.
