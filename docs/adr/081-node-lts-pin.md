# ADR-081: Pin the repo to a single Node LTS major (Node 24)

## Status

Accepted

## Context

The repo declared `engines.node: ">=22.17.0"` and hardcoded `"22"` in three
separate workflow places (`ci.yml`'s `env.NODE_VERSION`, `release.yml`'s own
`env.NODE_VERSION`, and a literal `node-version: "22"` in `codeql.yml`). Nothing
tied those together, and nothing tied any of them to the runtime a developer
actually ran.

The result, measured on 2026-08-01: **CI ran Node 22 while a maintainer's machine
ran Node 26.4.0**, three majors apart, with no warning from any tool. The
open-ended `>=22.17.0` is satisfied by Node 26, so `pnpm install` was content.

Two distinct costs motivated fixing this:

1. **Functional.** A dependency (or the runtime itself) can move to a major the
   project has not validated, and the failure surfaces at runtime rather than at
   install or build time.
2. **Code-generation fidelity.** Implementation work here is largely
   agent-assisted, and models are trained on data that lags current releases. On
   a runtime newer than that training data an agent emits code against APIs and
   semantics it does not reliably know; TypeScript catches shape errors, not
   behavioral drift. Measured against Anthropic's published cutoffs, Node 24
   (LTS since 2025-10-28) sits comfortably inside the training windows of the
   models used here, while Node 26 (LTS only from 2026-10-28) sits outside all of
   them.

Node 26 was the live risk, not a hypothetical one: it was the maintainer's actual
local runtime, and dependency automation had already proposed `@types/node@^26`
for `tools/verify` (PR #557, closed) while the engine floor and CI stayed on 22 —
a typings-only bump that would have let `tsc` validate against an API surface the
runtime did not have.

## Decision

Pin the whole repo to **Node 24 LTS**, declared in one place per concern and
enforced rather than documented.

**Bounded range, not a floor.** `engines.node` is `">=24 <25"` in both the root
package and `tools/verify`. An open-ended `>=24` is what allowed the original
drift; it admits every future major. Measured directly: with `>=24` and
`engineStrict` on, Node 26.4.0 installs cleanly (exit 0); with `">=24 <25"` the
same install fails (exit 1).

**`.nvmrc` is the single source of truth for the runtime.** It contains `24`.
Every `actions/setup-node` step reads `node-version-file: ".nvmrc"`, and the
duplicated `NODE_VERSION` env vars and the hardcoded `codeql.yml` value are
deleted. Local version managers (nvm, fnm, mise, asdf) read the same file, so
local and CI resolve from one place.

**`engineStrict: true` in `pnpm-workspace.yaml`** makes a wrong runtime fail the
install instead of warning. This spelling is load-bearing and was determined
empirically against pnpm 11.0.8:

| Setting | Location | Result on violating runtime |
| --- | --- | --- |
| _(none)_ | — | warns, **exit 0** |
| `engine-strict=true` | `.npmrc` | no effect, **exit 0** |
| `engine-strict: true` | `pnpm-workspace.yaml` | no effect, **exit 0** |
| `engineStrict: true` | `pnpm-workspace.yaml` | **exit 1** ✓ |

Note this contradicts the common guidance that pnpm fails on a root-project
`engines` mismatch by default, and the npm-style `.npmrc` spelling. Neither holds
for pnpm 11.

**The setting must be repeated in every workspace root.** pnpm reads settings
from the nearest `pnpm-workspace.yaml` walking up from the cwd and stops at the
first one. `tools/verify` is deliberately its own isolated workspace root, so the
repo root's `engineStrict` does not reach it: `pnpm --dir tools/verify install`
on Node 26.4.0 exited 0 against its own `">=24 <25"` until the setting was added
to `tools/verify/pnpm-workspace.yaml` as well. Any future isolated workspace
needs the same line.

**The range parser fails closed.** `scripts/check-node-pin.ts` accepts only `^N`
and `>=N <N+1`. Two classes of range look valid to a naive parser but are
satisfied by a later major, and both are rejected explicitly: unions
(`^24 || ^27` — the caret prefix parses fine) and leaky upper bounds
(`>=24 <25.5` — admits 25.0–25.4). Ranges that do pin one major in semver but are
not canonical (`24.x`, `~24.2`, `<25 >=24`) are also rejected rather than
guessed at, with a message naming the actual problem. `scripts/check-node-pin.test.ts`
pins these cases; `vitest.config.ts`'s unit project was extended to cover
`scripts/**/*.test.ts` so repo-owned gates carry tests like any other code.

**`@types/node` tracks the runtime major** (`^24.13.3`) in both packages.

**`pnpm check:node-pin`** (`scripts/check-node-pin.ts`) asserts that `.nvmrc`,
both `engines.node` ranges, both `@types/node` majors, and the running
interpreter all name the same major, and that each range is bounded. It runs in
CI's lint job and locally.

**Dependency automation is told the target, to the extent each tool can hear it.**

- *Renovate* auto-detects the constraint from `engines.node` and `.nvmrc`.
  `constraintsFiltering: "strict"` is enabled for runtime `dependencies`, so
  releases whose own `engines.node` does not overlap ours are not proposed.
  A `constraints` block is deliberately **not** declared: Renovate treats a
  manually-set constraint as fixed and will never offer to bump it, which would
  fork the source of truth away from `engines.node`. Node major bumps are
  disabled; `node-version` datasource and `@types/node` are bounded `<25.0.0`.
- *Dependabot* has no equivalent of `constraintsFiltering` — its `ignore` /
  `allow` / `versioning-strategy` / `groups` levers act on semver update *type*,
  never on runtime compatibility. It cannot be made Node-aware. It keeps its
  coverage role (ADR of record: it runs alongside Renovate deliberately), with an
  explicit `@types/node` major ignore so it cannot repeat PR #557, and CI as the
  real backstop.

## Consequences

**A wrong local runtime now fails loudly.** `pnpm install` exits 1 with the
expected-vs-actual versions. This is the intended behavior and it lands
immediately: anyone not on Node 24 must install it before working in the repo.
A version manager reading `.nvmrc` is the ergonomic path; the README's Quick Start and
CONTRIBUTING's "Node version" section document the per-manager commands. Note
Volta is the one manager that ignores `.nvmrc` — it reads only a `volta` key in
`package.json`, which is deliberately not added here because it would be a second
source of truth that can silently win over `engines.node`.

**Moving majors becomes a deliberate, visible change.** No single automated PR
can advance the runtime. The move touches `.nvmrc`, two `engines.node` ranges,
two `@types/node` majors, and is gated by `check:node-pin` — which is the point,
but it does mean the next LTS migration is a small piece of coordinated work
rather than a merge.

**Renovate will propose fewer upgrades**, by design. Strict constraint filtering
is stricter than most users expect; a package that has moved to `engines.node:
">=26"` simply stops being offered. That is the intended signal, but it can look
like Renovate has gone quiet. Filtering is scoped to runtime `dependencies` for
this reason, and it only covers **direct** dependencies — a transitive package
requiring a newer Node is not caught by it.

**Node 24 has a shelf life.** It enters maintenance 2026-10-20 and reaches EOL
2028-04-30. The pin should be revisited as EOL approaches — tracked in #576 —
rather than on the appearance of a newer major. Node 26 should not be adopted
before it is LTS (2026-10-28) and has accumulated ecosystem and training-data
coverage after that.

**A dead CodeQL job was found while aligning the workflows.** `codeql.yml`
pinned pnpm 9, which cannot read a pnpm 11 `pnpm-workspace.yaml` (`packages field
missing or empty`); its `pnpm install` had failed on every scheduled run since at
least 2026-06-22, so JS/TS CodeQL analysis was silently not running for roughly
six weeks. Because CodeQL is cron-only, no PR ever surfaced it. Pinned to
`11.11.0` to match the other workflows. This is pre-existing and unrelated to the
Node pin — measured identically on `main` — but it was fixed here rather than
left broken in a file this change already touches.

**`target: "ESNext"` in `tsconfig.json` is left unchanged** and remains a
separate, unaddressed drift risk: it emits whatever the current TypeScript
supports rather than what Node 24 accepts. Aligning it (for example via
`@tsconfig/node24`) is deliberately out of scope here because it changes emit and
warrants its own validation.
