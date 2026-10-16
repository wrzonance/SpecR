# ADR-096: Reference the logger worker during shutdown

## Status

Accepted — 2026-10-16.

## Context

Pino's file transport runs in a worker. Pino unrefs that worker when it becomes
ready, so awaiting its `close` event alone does not keep Node alive. A production
file logger can exit with an unsettled shutdown promise. Registering for `close`
again after it has fired also leaves repeated shutdown calls pending.

## Decision

Cache one shutdown promise, register completion before ending the transport, and
reference the worker until completion. Reapply the reference on `ready` because
Pino's ready listener may run after shutdown starts. Remove that listener and
unref the worker when completion settles, including an error.
If the worker has already closed before shutdown is first requested, resolve
immediately instead of registering for a past event.

Use Node's `process.ref` / `process.unref` helpers, available in the pinned Node 24
runtime and compatible with the transport's existing methods. These APIs remain
experimental; they avoid a type assertion around methods missing from the
transport's TypeScript declarations. Do not keep an unrelated timer alive to
mask the worker lifecycle.

## Consequences

Immediate, concurrent, and repeated shutdown calls drain the same transport.
Real subprocess tests verify natural process termination and the final file
record when shutdown is requested immediately after import. A separate test
verifies shutdown after a handled worker startup failure. Stdout-only logging
remains a no-op. An error during an active drain rejects the shared promise
rather than retrying the failed worker; the server shutdown caller always exits
in its `finally` block. ThreadStream's existing drain timeout remains in force.

References: [Node process.ref](https://nodejs.org/docs/latest-v24.x/api/process.html#processrefmayberefable),
Pino's installed `lib/transport.js` readiness and automatic shutdown handlers.
