# ADR-056: Logging & parse-observability hardening

## Status

Proposed — 2026-07-08. Precedes the "pressure phase" (a larger, more diverse and
malformed corpus, plus an autonomous "fix-as-it-finds" review loop driven over MCP).
Scope of this ADR: **P0 + P1** below. **P2 is deferred** to a follow-on.

## Context

SpecR is about to ingest a far more diverse corpus (malformed OOXML, corrupted-font
PDFs, structural edge cases) and to run an agent loop that reads errors/logs to drive
fixes. The current logging surface cannot support that:

- `src/lib/logger.ts` is a 9-line pino logger: JSON to **stdout** in prod, pretty in
  dev. **No file sink, no rotation, no child loggers, no correlation id.**
- The parser (`src/parser/**`) **logs nothing** — parse observability is modelled as
  data on the AST (`SpecTree.warnings`, 11 `ParseWarningType`s incl. `unusual-part-count`).
- Those warnings are **not persisted and are dropped entirely on the MCP
  `parse_document` and `load_files` paths** — i.e. the exact batch/MCP interface the
  loop drives is blind to them. Only the REST `/parse` job result and the onboarding
  report carry them, and only into an in-memory job `Map` with a 1-hour TTL.
- Silent-degradation swallows emit no signal at all: `docx/index.ts` corrupt `core.xml`
  → `{section:'unknown'}`; `infer-section.ts` → `NONE_RESULT`; PDF OCR/extract failures
  discard their typed cause.
- All 8 domain error classes are empty markers (`extends SpecrError {}`) — no `code`,
  so an agent must string-match prose to triage.

**Key leverage point:** `tree.warnings` and the `{filename, sha256, loader}` origin
metadata are already available at the **main-thread boundary** (`api/parse.ts`,
`api/onboarding.ts`, `mcp/parse-document-handler.ts`, `lib/file-loader.ts`). The entire
fix can land there **without touching the parser, the Piscina worker, or Postgres** —
the parser stays log-free, honouring the module boundaries.

Research (cited in the design thread): structured **JSONL** is the machine/agent-consumption
norm and pino already emits JSON; **child loggers** are the standard per-item context
mechanism; pino's `err` serializer already walks the `cause` chain and emits an error's
`code`; **dead-letter/quarantine-per-item** is the ETL norm for document pipelines;
**OpenTelemetry is overkill for a single service**.

## Decision

1. **File sink — JSONL to `logs/`, rotated by `pino-roll`.** Reshape `logger.ts` to a
   `pino.transport({ targets })` with (a) stdout/`pino-pretty` as today and (b) a
   `pino/file` (worker-thread) destination wrapped by `pino-roll` (size + daily). Gate
   the file target behind new `LOG_DIR`/`LOG_FILE` env (Zod-validated in `env.ts`,
   fail-fast, disabled in `test`). Add `logs/` to `.gitignore`.
2. **Per-document child logger.** At each of the four boundaries, derive
   `logger.child({ filename, sha256, loader, specId|jobId })` once and use it for every
   line in scope. Bind untrusted values (filenames) under fixed, app-controlled keys.
   In `file-loader.ts`, hoist `sha256Hex(buffer)` to right after read so pre-persist
   failures are still attributable. This is the correlation the batch use-case needs —
   no OTel, no request-id plumbing.
3. **Surface `SpecTree.warnings` on every path.** Emit them at `warn` on completion, add
   `warnings` to `LoadResult` (`file-loader.ts`), and include `warnings` in the MCP
   `parse_document` response — closing the documented MCP/load blind spots.
4. **Failure taxonomy — `code` on `SpecrError`.** Add an optional `code` (typed
   per-module string-literal unions, e.g. `DOCX_ARCHIVE_UNREADABLE`, `DOCX_NO_PARAGRAPHS`,
   `NUMBERING_XML_INVALID`, `PDF_TEXT_LAYER_UNEXTRACTABLE`, `UNSUPPORTED_FORMAT`) and
   thread it into existing `throw new ParserError(...)` sites. pino's std `err`
   serializer emits `code` for free, so an agent branches on `err.code`, not prose.
   Optionally centralise the `code → HTTP status` map in `api/middleware/error.ts`.
5. **Convert the worst silent swallow into signal.** Keeping the parser log-free, turn
   the corrupt-`core.xml` degradation (`docx/index.ts` `parseCoreMetadata`) into a
   `core-metadata-unreadable` `ParseWarning` — data on the tree, which then rides step 3
   into the logs. (The `inferSectionMeta` swallow and the PDF cause-summary swallows are
   entangled with the worker-thread boundary and are deferred to P2.)

**Rejected alternatives:** a DB `parse_runs` table (couples parse-observability to the
very DB whose failure we want to log; no cross-run-SQL need for a single-box corpus run —
revisit only when that need is concrete); **plain text** (loses field queries — the whole
point is agent/field queryability); **OpenTelemetry** (unanimously overkill for one
process; revisit if SpecR becomes multi-service); **system `logrotate`** for now (no
guaranteed wiring on a dev box; `pino-roll` is zero-config and cross-platform — switch to
logrotate later as a config, not code, change).

## Scope

- **P0** — file sink (1) + child logger (2) + warning surfacing (3).
- **P1** — failure taxonomy (4) + swallow→warning conversion (5).
- **P2 (deferred, follow-on ADR/PR)** — a per-document `logs/parse-diagnostics-<runId>.jsonl`
  (`outcome: clean|warnings|failed` per file — the DLQ/quarantine record the autonomous
  loop tails, modelled on `lib/fixture-snapshot.ts`'s Zod'd record shape); the
  `inferSectionMeta` and PDF cause-summary swallow→warning conversions (worker-boundary
  entanglement); optional `x-request-id` middleware; `redact`/serializer config.

## Consequences

- **New dependency `pino-roll`** (MIT, pino-org) — vet + lockfile-pin per `security.md`
  before adoption; it is the only new runtime dep.
- A durable, per-document, **warning-visible, field-queryable JSONL** log under `logs/`
  that survives process exit — the substrate the autonomous fix-loop reads. Nothing does
  this today.
- Surface changes: `SpecrError` gains optional `code`; `LoadResult` gains `warnings`; the
  MCP `parse_document` response gains `warnings`; `ParseWarningType` gains
  `core-metadata-unreadable` (and likely an inference-errored type). The MCP response
  shape change **must be reflected in `openapi.yaml`/tooling contracts** in the same PR
  (contract gate + ADR-044 MCP parity).
- No change to the AST itself or to inference behaviour — existing parser/inference tests
  stay green; this is additive observability.

## Invariants (become the tests)

1. A parse producing warnings emits ≥1 `warn` line carrying those warnings **and** the
   document's `sha256` binding — on all three paths (REST job, MCP, `load_files`).
2. `load_files`/`LoadResult` includes `warnings` per file; MCP `parse_document` response
   includes `warnings`.
3. A thrown `ParserError` carrying a `code` serialises that `code` into the log line.
4. A corrupt `core.xml` produces a `core-metadata-unreadable` `ParseWarning` rather than
   a silent `unknown` (the `inferSectionMeta` swallow is deferred to P2).
5. With `LOG_FILE` set, a run writes valid JSONL (one object per line) to `logs/`; with
   the test env, the file target is disabled.
6. `openapi.yaml`/MCP contract tests stay green after the `parse_document` response gains
   `warnings`.
