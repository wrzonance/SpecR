# SpecR

Headless REST API for CSI MasterFormat specification document automation with round-trip DOCX support.

## Architecture

Read ARCHITECTURE.md for the full spec. Key points:

- TypeScript/Node.js API — Express, PostgreSQL, Zod for validation
- Canonical CSI AST as internal representation — not raw OOXML
- Multi-signal DOCX hierarchy inference engine (ported from Clippit/C#)
- UFGS .SEC parser (SpecsIntact XML → AST) as the first implementation
- Content controls (`w:sdt`) with UUID tags as round-trip merge anchors
- Git-style 3-way merge for owner redlines

## Build

```bash
pnpm install            # Install dependencies
pnpm dev                # Development server (ts-node-dev, hot reload)
pnpm build              # Compile TypeScript → dist/
pnpm start              # Run compiled output
pnpm test               # Unit tests (no DB required)
pnpm test:integration   # Integration tests (requires PostgreSQL — see docker-compose.yml)
pnpm lint               # ESLint + tsc --noEmit
pnpm format             # Prettier write
pnpm format:check       # Prettier check (CI)
pnpm migrate            # Run pending DB migrations
pnpm migrate:down       # Roll back last migration
```

### Local Development Prerequisites

```bash
# PostgreSQL (via Docker)
docker compose up -d postgres

# Or native install
# Arch: sudo pacman -S postgresql
# Ubuntu: sudo apt install postgresql libpq-dev
```

## Project Structure

```
src/
├── index.ts              # Entry point: Express app, env validation, shutdown
├── api/
│   ├── router.ts         # Route composition
│   ├── middleware/
│   │   ├── error.ts      # Global error handler → ApiResponse shape
│   │   └── validate.ts   # Zod request validation middleware
│   ├── parse.ts          # POST /parse
│   ├── specs.ts          # GET /specs/:id, PATCH /specs/:id
│   ├── generate.ts       # POST /specs/:id/generate
│   ├── diff.ts           # POST /specs/:id/diff
│   └── merge.ts          # POST /specs/:id/merge
├── parser/
│   ├── index.ts          # parse() orchestrator — detects format, delegates
│   ├── error.ts          # ParserError
│   ├── sec/
│   │   └── index.ts      # UFGS .SEC (SpecsIntact XML) → canonical AST
│   └── docx/
│       ├── index.ts      # DOCX parser orchestrator
│       ├── numbering.ts  # numbering.xml: abstractNum → num → pStyle linkage map
│       ├── styles.ts     # styles.xml: basedOn chains, numPr-carrying styles
│       ├── inference.ts  # Multi-signal hierarchy inference engine (5 signals)
│       └── heuristics.ts # Text-content + indentation heuristics
├── generator/
│   ├── index.ts          # AST → DOCX (dolanmiu/docx)
│   ├── error.ts          # GeneratorError
│   ├── numbering.ts      # CSI multilevel numbering engine
│   └── controls.ts       # w:sdt UUID content control injection
├── merge/
│   ├── index.ts          # 3-way merge orchestrator
│   ├── error.ts          # MergeError
│   ├── diff.ts           # 3-way diff algorithm
│   └── conflict.ts       # Conflict detection + resolution
├── db/
│   ├── index.ts          # pg Pool, query helper
│   ├── migrations/       # Numbered .sql files — always reversible (up + down)
│   └── queries/
│       ├── specs.ts      # Spec CRUD
│       ├── paragraphs.ts # Tree queries (recursive CTEs)
│       └── versions.ts   # Base version tracking per paragraph
├── ast/
│   ├── types.ts          # CsiNode, CsiTree, NodeType — canonical AST types
│   └── schemas.ts        # Zod schemas for all AST node types
└── lib/
    ├── errors.ts         # SpecrError base class
    └── logger.ts         # Structured logging (pino)
```

## Conventions

- TypeScript strict mode — no `any`, no `as unknown as`, no type assertions across module boundaries
- Immutable patterns: create new objects, never mutate. Spread operators, not property assignment.
- Functions: max 50 lines. Files: max 400 lines. Extract when approaching limits.
- Organize by feature/domain, not by type.
- Commit format: `type(scope): description` — types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`
- Scope reflects the module changed: `feat(parser): add numbering.xml analyzer`
- No `console.log` in src/ — use `lib/logger.ts` (pino)

## Error Handling — Context Chains

Every error must carry full context from origin to surface. Never lose the "why" chain.

**Pattern:**
- Custom error class per module boundary — extends `SpecrError`
- `cause` chaining at every catch site where the caller adds meaning
- Zod for all external input validation (request bodies, env vars, parsed XML/OOXML)

```typescript
// lib/errors.ts
export class SpecrError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = this.constructor.name
  }
}

// parser/error.ts
export class ParserError extends SpecrError {}

// parser/docx/numbering.ts — correct context chaining
function buildNumberingMap(xml: string): NumberingMap {
  try {
    return parseNumberingXml(xml)
  } catch (err) {
    throw new ParserError('failed to build numbering map from numbering.xml', { cause: err })
  }
}

// Result: error chain reads:
//   ParserError: DOCX parse failed
//   Caused by: ParserError: failed to build numbering map from numbering.xml
//   Caused by: Error: abstractNum id="3" references undefined numId
```

**Anti-patterns (rejected in review):**

```typescript
// BAD: swallows context
} catch (_err) {
  throw new ParserError('failed')
}

// BAD: any across module boundary
function parse(input: any): any { ... }

// BAD: non-null assertion in non-test code
const node = map.get(id)!

// BAD: raw Error with no typed boundary
function buildMap(): Record<string, unknown> { ... }
```

**API error surface:** All errors caught by `api/middleware/error.ts` and mapped to `ApiResponse<never>` with appropriate HTTP status. `ParserError` → 422, `MergeError` (conflict) → 409, unknown → 500. Stack traces never leave the process.

## Complexity Controls

### ESLint (`.eslintrc.json`)

```json
{
  "rules": {
    "complexity": ["error", 10],
    "max-lines-per-function": ["error", { "max": 50 }],
    "max-lines": ["error", { "max": 400 }],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/prefer-readonly": "error",
    "sonarjs/cognitive-complexity": ["error", 10],
    "no-console": "error"
  }
}
```

### TypeScript (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

## Module Boundaries

Each module in `src/` is a self-contained unit with: a typed error class, a public API exported from `index.ts`, and no leaked internals. Modules do not import from each other's internals — only from their `index.ts`.

```
parser/    ← knows about AST types, knows nothing about DB or API
generator/ ← knows about AST types and dolanmiu/docx, nothing else
merge/     ← knows about AST types and DB queries, nothing about parsing
db/        ← knows about AST types and pg, nothing about domain logic
api/       ← orchestrates all modules, owns HTTP concerns only
```

Imports between modules go through `index.ts` re-exports only:

```typescript
// CORRECT
import { parse } from '../parser'

// WRONG — leaks internal structure
import { buildNumberingMap } from '../parser/docx/numbering'
```

## Architecture Decision Records (ADRs)

When a non-obvious decision is made, record it. Future agents and contributors need to know WHY, not just WHAT.

```
docs/adr/
  001-typescript-over-python-java.md
  002-api-first-headless.md
  003-canonical-csi-ast.md
  004-content-controls-as-merge-anchors.md
  005-git-style-3-way-merge.md
  006-multi-tier-paragraph-libraries.md
  007-all-divisions-from-day-one.md
  008-markdown-parallel-output.md
  009-revit-direct-api-calls.md
```

**ADR format:**

```markdown
# ADR-NNN: Title

## Status: Accepted | Superseded by ADR-XXX | Deprecated

## Context
What situation prompted this decision?

## Decision
What did we choose?

## Consequences
What trade-offs does this create?
```

Write an ADR when: choosing between two viable approaches, rejecting a popular approach, making a decision that will surprise future readers.

## Scope Creep Prevention

- **Phases are gates.** Phase 2 does not start until Phase 1 is merged, tagged, and verified end-to-end.
- **Feature requests go to a backlog issue.** Not planned until the current phase ships.
- **"Not now" is valid.** If a feature doesn't serve the current phase's sub-MVP, it waits.
- **Every plan states what is OUT of scope** — explicitly. "This PR does NOT include web UI" prevents drift.
- **New dependency requires justification.** New package = PR comment explaining why existing deps can't do it.
- **UFGS seed data is not the product.** Parsing UFGS is Phase 1 proof-of-concept. The product is the inference engine and round-trip fidelity, not the content library.

## Sub-MVP PR Discipline

Every PR must have a single, demonstrable outcome — not "progress toward Phase 1."

**Rules:**
- **500 LOC max per PR** (excluding fixtures, migrations, `pnpm-lock.yaml`, `openapi.yaml`, `docs/references/`). CI warns; reviewer enforces.
- **Each PR = one sub-MVP.** Smallest unit a reviewer can understand, test, and verify in isolation. Examples:
  - "SEC parser reads `<PRT>`/`<SPT>`/`<TXT>` into CsiNode tree" — sub-MVP
  - "numbering.xml analyzer builds abstractNum → num → pStyle map" — sub-MVP
  - "PostgreSQL migrations create spec + paragraph + version tables" — sub-MVP
  - "Phase 1 complete" — NOT a sub-MVP
- **Each PR has a test plan** in the description. Exact commands to run. What to verify.
- **Each PR must pass CI independently.** No "breaks but next PR fixes it."
- **PR title format:** `feat(parser): build abstractNum → num → pStyle linkage map`

## Branch Strategy

```
main                          ← always builds, always passes CI
 └── feat/sec-parser          ← one sub-MVP per branch
 └── feat/numbering-analyzer  ← branch from main, not from other feat branches
 └── fix/ilvl-gap-masterspec  ← fixes also get branches
```

No long-lived feature branches. Branch from main, PR back to main, delete branch after merge.

## TDD — Mandatory for All Code

Red → Green → Refactor. No implementation code without a failing test first.

1. Write failing test (`pnpm test` → red)
2. Write minimal code to pass (`pnpm test` → green)
3. Refactor if needed, tests stay green
4. Commit

**What gets tested:**
- Parser: known .SEC and .docx fixtures → expected AST output (deterministic)
- Inference engine: paragraph sequences with known ilvl/style/text → expected hierarchy
- Generator: AST → DOCX → re-parse → AST round-trip fidelity
- Merge: 3-way diff with known base/theirs/ours → expected conflict set
- DB queries: integration tests against real PostgreSQL
- API: request/response contracts (HTTP status, body shape)

**What does NOT get tested:**
- Third-party library internals (dolanmiu/docx rendering, pg driver)
- Database schema design (schema = migration files, not test targets)
- Content accuracy of UFGS reference data

**Regression rule:** Every bug-fix gets a regression test. Test name includes the symptom: `'inference: MASTERSPEC ilvl gap — Article at ilvl=3, not ilvl=1'`

## CI/CD Pipeline

Every push to a PR branch triggers:

```yaml
jobs:
  lint:   ESLint + tsc --noEmit + prettier --check
  test:   Unit tests (no DB) + integration tests (postgres service)
  build:  pnpm build — verifies compilation succeeds
  loc-check: warn if PR LOC delta > 500 (excludes fixtures, migrations, lockfile)
```

Every tagged release (`v*`) triggers: npm audit, depcheck, version verification, AI release notes, GitHub release.

## Agent Orchestration for Development

| Task | Model | Why |
|------|-------|-----|
| Plan writing, architecture decisions | **Opus** | Deep reasoning, cross-cutting analysis |
| OOXML inference engine implementation | **Opus** | High complexity, subtle invariants |
| Standard API/DB code | **Sonnet** | Fast, accurate code generation |
| Code review | **Opus** | Catches subtle bugs, architectural drift |
| Test writing | **Sonnet** | Mechanical, pattern-based |
| CI/CD configs | **Sonnet** | Templated, well-documented |
| Debugging inference failures | **Opus** | Requires tracing 5-signal combinations |

**Parallel agent patterns:**
- Plan writing: architect + security reviewer + feasibility checker in parallel
- Implementation: one agent per sub-MVP (isolated worktrees), review agent after each
- Pre-merge: lint + test + build agents in parallel

**Plan writing rules:**
- Every plan written before implementation begins
- TDD structure: test spec first, then implementation, then verification
- Plans reviewed by separate agent before execution
- Plans specify exact files, exact test names, exact commands

## Testing Philosophy

Every test must justify itself against four properties:
1. Protects against real regressions (parser produces wrong hierarchy → DOCX is malformed)
2. Resists refactoring (tests break on behavior change, not internal restructuring)
3. Fast enough to actually run (unit tests < 100ms each; integration tests < 5s each)
4. Readable: test name describes the scenario and expected behavior

Coverage % is a diagnostic, not a target. Tests at module API boundaries beat tests on internals. Pin every bug-fix with a regression test.

**OOXML-specific rule:** The inference engine has known ambiguous cases (see research summary). When a case is genuinely ambiguous, document it in a test marked `// KNOWN AMBIGUITY: <description>` rather than picking an arbitrary behavior silently.
