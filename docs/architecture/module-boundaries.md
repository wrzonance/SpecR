# Module Boundaries & Error Handling

> ↩ [Architecture index](../../ARCHITECTURE.md)

## Module Boundaries

Each module in `src/` is a self-contained unit: a typed error class, a public API exported from its `index.ts`, no leaked internals. Modules import only from a sibling's `index.ts` barrel, never from its internal files.

`lib/` is the one exception: it is not a module with a public API but a collection of leaf utilities (`errors.ts`, `logger.ts`, `env.ts`, …). It has no barrel: import the file you need directly, e.g. `import { logger } from '../lib/logger.js'`.

```text
parser/    ← knows about AST types; nothing about DB or API
generator/ ← knows about AST types and dolanmiu/docx; nothing else
merge/     ← knows about AST types and DB queries; nothing about parsing
db/        ← knows about AST types and pg; domain engines only via barrels (conventions classify, parser read-time scorer — ADR-055)
api/       ← orchestrates all modules; owns HTTP concerns only
mcp/       ← imports from db/index, generator/index, parser/index; no api/ internals
lib/       ← format-agnostic utilities (errors, logging, encoding); usable by any module
```

```typescript
// CORRECT — through the barrel
import { parse } from '../parser/index.js'

// WRONG — leaks internal structure
import { buildNumberingMap } from '../parser/docx/numbering.js'
```

## Error Handling — Context Chains

Every error carries the full "why" chain from origin to surface. The pattern:

- One custom error class per module boundary, extending `SpecrError` (`src/lib/errors.ts`): `ParserError`, `GeneratorError`, `MergeError`.
- `cause` chaining at every catch site where the caller adds meaning.
- Zod for all external-input validation (request bodies, env vars, parsed XML/OOXML); chain the `ZodError` as `cause`.

```typescript
// src/lib/errors.ts
export class SpecrError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = this.constructor.name
  }
}

// src/parser/error.ts
export class ParserError extends SpecrError {}

// src/parser/docx/numbering.ts — correct context chaining
function buildNumberingMap(xml: string): NumberingMap {
  try {
    return parseNumberingXml(xml)
  } catch (err) {
    throw new ParserError('failed to build numbering map from numbering.xml', { cause: err })
  }
}

// Resulting chain:
//   ParserError: DOCX parse failed
//   Caused by: ParserError: failed to build numbering map from numbering.xml
//   Caused by: Error: abstractNum id="3" references undefined numId
```

Anti-patterns rejected in review:

```typescript
} catch (_err) { throw new ParserError('failed') }   // swallows context
function parse(input: any): any { ... }              // any across a boundary
const node = map.get(id)!                            // non-null assertion in non-test code
function buildMap(): Record<string, unknown> { ... } // untyped raw boundary
```

**API error surface:** the shared middleware (`src/api/middleware/error.ts`) maps `MulterError` → 400 and otherwise responds `err.status ?? 500` as `ApiResponse<never>`. Specific statuses are set upstream: Zod validation failures → 422 (`src/api/middleware/validate.ts`); version/lock/edit-gate conflicts → 409 (`src/api/edit-gate-response.ts`, `src/api/locks.ts`). Stack traces never leave the process.

## Complexity Controls (enforced)

ESLint (`eslint.config.js`), `error` severity, not warnings:

```js
complexity: ['error', 10],
'sonarjs/cognitive-complexity': ['error', 10],
'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
'no-console': 'error',
'@typescript-eslint/no-explicit-any': 'error',
```

Test files (`src/**/*.test.ts`) relax the line/function/console caps; `scripts/**/*.ts` relax `no-console` only (see config for the exact carve-outs). TypeScript strict mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` (`tsconfig.json`).
