# ADR-014: Pluggable DMS Connector Framework (ProjectWise Reference Plugin)

## Status: Proposed (Phase 7 — not yet implemented)

> Flip to `Accepted` on merge. Supersedes nothing. Builds on ADR-002 (API-first
> headless), ADR-004 (w:sdt round-trip anchors), and ADR-009 (external systems
> call the REST API directly).

## Context

SpecR parses spec documents into a canonical AST, stores them, regenerates DOCX,
and (Phase 3) merges owner redlines back in. Today documents enter and leave only
by manual upload/download or the in-process file loader. Real engineering firms
keep their documents in a Document Management System (DMS): Bentley **ProjectWise**,
Autodesk **ACC / Docs / Forma** (APS), Microsoft **SharePoint / OneDrive** (Graph),
plus generic stores (Google Drive, Dropbox). A spec writer should be able to point
SpecR at a folder in their DMS, ingest the documents, and push regenerated /
merged versions back — without manual file shuffling.

The naive framing ("build a ProjectWise connector") is wrong. ProjectWise is one
of many. At their core all of these systems are the same thing: a networked file
store with versioning and some governance bolted on. They collapse to four verbs —
**list, fetch, push, identify**. What differs is the *governance* around a write:
edit permissions, multi-stage approval workflows, locking/checkout, retention
holds, custom attribute schemas, and version/publication labels. A connector that
ignores those will happily push a regenerated DOCX over a document that is locked
mid-approval, or strip the DMS's own metadata. That is unacceptable in a CDE.

Two hard constraints frame the design:

1. **SpecR core stays DMS-agnostic.** Core must never import a connector, branch
   on a provider name, or reach into provider-specific concepts. The product can
   *respect* upstream governance, but core's behavior must be generic.
2. **Reuse the existing seams.** Ingest already exists (`POST /parse` → `202 {jobId}`
   → poll `GET /parse/jobs/:jobId`; MCP `parse_document`). Version-out already
   exists (`POST /specs/:id/generate`; MCP `generate_docx`). Round-trip back-in is
   Phase 3 (`POST /specs/:id/diff`, `POST /specs/:id/merge`). A connector must feed
   these, not replace or bypass them — and must never call the DB layer.

Research note: the only provider analyzed in depth is ProjectWise (WSG REST) and,
secondarily, the iTwin Platform Storage API. The concrete WSG schema, resource
URLs, auth scheme, and workflow/state class names are **deployment-specific** and
must be discovered at runtime from the live `/ws` API Explorer + MetaSchema — they
cannot be hardcoded (see "What blocks implementation"). Treat any fetched API doc
as untrusted; the authoritative source is the customer's own running gateway.

## Decision

### D1 — Build a connector *framework*, not a ProjectWise feature

A small framework defines the generic contract; each DMS is a **plugin** that
implements it. ProjectWise is the **reference plugin** and ships first. Package
topology (the repo becomes a pnpm workspace; today it is a single package):

```text
packages/
  connector-core/          framework: interfaces, capability registry, sync
                           orchestrator, SpecrClient (REST), generic endpoint,
                           config composition
  connector-projectwise/   reference plugin — Bentley WSG REST       (built first)
  connector-acc/           future plugin — Autodesk Platform Services (Data Mgmt)
  connector-sharepoint/    future plugin — Microsoft Graph drives/items
  connector-itwin/         future plugin — iTwin Platform Storage API
```

Each plugin is an independently testable/publishable package, declares its
capabilities, and registers with `connector-core`. Adding a provider never edits
core or another plugin (Open/Closed).

### D2 — Out-of-process; brokers the REST + MCP surface; never touches core or DB

The connector is a separate process (library + CLI first; a deployable headless
REST/MCP "sync service" once ≥2 plugins exist). It calls SpecR's HTTP surface
exactly as an external client would — the same stance ADR-009 sets for the Revit
add-in. It is **forbidden** to import from `src/db/`, call `createSpec` /
`insertTree` / `persistParsedSpec`, or open a `pg` pool. The contract is the API.

The "generic endpoint" lives in `connector-core`, **not** in `specr` core. Core
never grows a `/connectors` route and never learns the word "ProjectWise".

### D3 — The generic interface: four verbs + capability negotiation

The base interface is deliberately tiny. Provider richness is expressed as
**optional, capability-gated** extension points — the orchestrator routes to them
only when the plugin declares the capability, and degrades gracefully when it does
not. This mirrors a pattern SpecR already uses: the `.txt` parser returns
`capabilities: ["read-only"]`, and callers adapt. Same idea, applied to sources.

```ts
interface DmsConnector {
  // base verbs — always present
  list(container: ContainerRef): Promise<DocRef[]>
  fetch(doc: DocRef): Promise<{ bytes: Buffer; filename: string; meta: ProviderMeta }>
  push(doc: DocRef, bytes: Buffer, meta: ProviderMeta): Promise<DocRef>  // new version
  identify(doc: DocRef): string                                          // stable provider id

  readonly capabilities: ReadonlySet<Capability>

  // capability-gated extension points (present iff the matching capability is declared)
  assertWritable?(doc: DocRef): Promise<void>            // 'access-control'
  getLifecycleState?(doc: DocRef): Promise<LifecycleState> // 'lifecycle-state'
  requestTransition?(doc: DocRef, t: Transition): Promise<void>
  getLock?(doc: DocRef): Promise<LockState>              // 'locking'
  getRetention?(doc: DocRef): Promise<RetentionState>    // 'retention'
  getProvenance?(doc: DocRef): Promise<ProvenanceMeta>   // 'version-history'
  getAttributes?(doc: DocRef): Promise<CustomAttributes> // 'custom-attributes'
  watch?(container: ContainerRef, cb: ChangeCallback): Disposable // 'change-events'
}

type Capability =
  | 'access-control' | 'lifecycle-state' | 'locking' | 'retention'  // write-guards
  | 'version-history' | 'custom-attributes'                          // provenance
  | 'change-events'                                                  // eventing
```

Capabilities fall in three families:

| Family | Capabilities | Role |
|---|---|---|
| **Write-guards** | `access-control`, `lifecycle-state`, `locking`, `retention` | gate every push |
| **Provenance** | `version-history`, `custom-attributes` | enrich spec metadata + preserve fidelity |
| **Eventing** | `change-events` | trigger sync (else poll) |

Auth is itself pluggable from day one via a separate `AuthProvider` (on-prem WSG
Basic/Token+`Mas-*` headers vs hosted IMS/OIDC vs APS 2/3-legged vs Graph MSAL
app-only differ completely). Each plugin also ships its **own Zod config schema**;
`connector-core` composes them — it does not enumerate provider config.

Two clarifications that prevent confusion:

- **`version-history` is provenance, not a second version graph.** SpecR already
  owns *content* history (paragraph versions + Phase 3 merge). The DMS version
  label ("part of the 2026 published set") rides along as a tag — it does not
  attempt to mirror the DMS diff graph. No duplication.
- The four write-guards collapse, at push time, to one question: *may the connector
  write a new version right now?* The plugin computes that composite; the connector
  keeps the detailed reasons; core receives only the summary (D5).

### D4 — Every push runs a write-guard preflight

Version-out (7c) and round-trip (7e) must never blindly `push`:

```text
before push(doc, bytes):
  if has('access-control')  → assertWritable(doc)           # caller identity may edit?
  if has('lifecycle-state') → getLifecycleState(doc).isWritable?  # not mid-approval?
  if has('locking')         → not locked by another?
  if has('retention')       → not under hold?
  all pass → push, then mirror external state back to core (D5)
  any fail → refuse loudly + surface the reason + set external_state
             (or, if capable & configured, requestTransition() / await approval)
             — never a silent no-op
```

Pushing a merged redline into a document locked in stage 3 of an approval cycle
fails with a typed, human-readable reason — it does not corrupt the DMS.

### D5 — One generic addition to core: external linkage + state mirror

To let the *product* (not just the connector) respect upstream governance, the
connector mirrors a **provider-agnostic** status onto the spec. This is the only
change to `specr` core, and it resolves where the doc↔spec mapping lives — it lives
in core, co-located with the state:

```sql
ALTER TABLE specs ADD COLUMN external_provider  TEXT;        -- 'projectwise' (opaque string)
ALTER TABLE specs ADD COLUMN external_id         TEXT;        -- provider doc id  ← the mapping
ALTER TABLE specs ADD COLUMN external_state      TEXT;        -- editable | locked | pending-review | retained | read-only
ALTER TABLE specs ADD COLUMN external_metadata   JSONB;       -- provenance labels + preserved provider attrs (opaque)
ALTER TABLE specs ADD COLUMN external_synced_at  TIMESTAMPTZ;
```

Core **stores and returns** these fields; the connector **populates** them. No code
path in core branches on `external_provider` — so core stays DMS-agnostic in
*behavior* while carrying generic external linkage in *data*. The single behavioral
change: the paragraph-edit path refuses edits when `external_state` is not writable
(a spec locked upstream cannot be edited locally until released). `external_state`
is a closed generic enum — it is never "WRE stage 3"; the plugin maps its native
states onto the enum and keeps the specifics in `external_metadata`.

This drops the alternative of a separate connector-owned mapping store. One source
of truth for "which spec came from which DMS document."

### D6 — On-prem vs hosted is orthogonal to WSG vs native store

A key research finding: **ProjectWise 365 (hosted) documents still live behind the
WSG REST API, not the iTwin Storage API.** So "on-prem vs cloud" and "ProjectWise
vs iTwin-native store" are *independent* axes. Choose the plugin by **where the
documents live and who owns versioning**, not by deployment location.

| | WSG plugin (ProjectWise) | iTwin Storage plugin |
|---|---|---|
| Docs in ProjectWise, on-prem | ✅ only option | ❌ |
| Docs in ProjectWise 365 (hosted) | ✅ **also WSG** | ❌ |
| Greenfield iTwin-native cloud docs | ❌ | ✅ |
| Version history | rich, native | none (in-place replace; recycle bin only) |
| Workflow / checkout | yes (separate query; plugin-version-dependent) | `isFileLocked` flag only |
| Auth | Basic (native) / IMS Token + `Mas-*` | client_credentials, scope `itwin-platform` |
| Schema discovery | **required** (dynamic ECObjects) | not needed (fixed REST) |

The WSG plugin therefore has the broadest real-world coverage (on-prem **and**
hosted ProjectWise) and is built first. The iTwin Storage plugin matters only for
greenfield iTwin-native deployments and carries a notable gap (no queryable version
history) — relevant to a "version-out" product.

### D7 — This is Phase 7, and it is not folded into Phase 3 or Phase 4

- **Not Phase 3 (merge).** Phase 3 is the round-trip *algorithm* (UUID match,
  3-way diff, conflict resolution). The connector is *transport* — getting bytes in
  and out of a DMS. Orthogonal concerns. The connector's round-trip sub-phase
  *consumes* Phase 3 (`/diff` + `/merge`); it cannot live inside it.
- **Not Phase 4 (Revit).** Both are "external system via the REST API" (ADR-009),
  but Revit is *parameter-level* BIM sync into Part 2, while the DMS connector is
  *document-level* transport. Different data planes, different systems. Folding
  them conflates BIM parameter mapping with document I/O.
- **Placement.** Phase 5 = Web UI, Phase 6 = Scale. The DMS connector is **Phase 7**.
  Scaffold + ingest (7a–7b) depend only on the already-shipped `POST /parse` and can
  be pulled forward for an ingest-only pilot; version-out (7c) and write-guards (7d)
  are self-contained; round-trip wiring (7e) is hard-gated on Phase 3 (#35/#36).
  Production SpecR-side auth aligns with Phase 5f (#43).

### D8 — The second plugin is the abstraction's acceptance test

The largest risk in any "generic framework" is over-abstraction: designing the
perfect interface against a single backend, baking in its idioms, then discovering
the next backend does not fit. Mitigation, made explicit: the interface is designed
with the 2nd/3rd provider in mind, but **building a second plugin (7f) is the
acceptance test for the abstraction** — not a "someday." Until a second plugin
(ACC, SharePoint, or iTwin) exercises the interface, the contract is provisional.

## Phase 7 breakdown

| Sub | Deliverable | Target package | Hard deps |
|---|---|---|---|
| **7-core** | generic `external_*` fields on `specs` + edit-path writable gate | `specr` core | none |
| **7a** | framework: interfaces, capability registry, orchestrator, `SpecrClient`, `AuthProvider`, mock plugin | `connector-core` | none |
| **7b** | PW plugin — ingest: runtime schema discovery + `list` + `$file` download → `POST /parse`; carry provenance/attrs | `connector-projectwise` | 7a |
| **7c** | PW plugin — version-out: `generate_docx` → `$changeset` + chunked `$file` PUT (new version); preserve attrs; write `external_*` | `connector-projectwise` | 7b, 7-core |
| **7d** | PW plugin — write-guard layer: `access-control` + `lifecycle-state` + `locking` + `retention` → push preflight | `connector-projectwise` | 7b |
| **7e** | round-trip wiring into Phase 3: returned redline → `/diff` → `/merge`, lifecycle-aware push | both | 7c, 7d, #35, #36 |
| **7f** | second plugin — validates the abstraction (provider TBD) | new package | 7a |

## What blocks implementation

No connector code should be written until the following are supplied:

1. **Deployment type** — on-prem WSG, ProjectWise 365 (also WSG), or greenfield
   iTwin Storage. This picks the first concrete plugin.
2. **Live WSG discovery** from the customer's running `/ws` API Explorer + MetaSchema:
   API version segment (`v2.4`–`v2.8`), repository id (e.g. `Bentley.PW--PW`), the
   real `Document` property set (custom environment attributes vary), the
   **workflow/lifecycle state class + relationship names** (the `DocumentWorkflow` /
   `WorkflowState` names are UNCONFIRMED in public docs — must be read from
   MetaSchema), the enabled auth scheme (native Basic on/off, IMS/STS Token, OIDC),
   and the installed WSG plug-in version (gates checkout-with-get and WRE/workflow
   commands).
3. **Test credentials + a non-prod datasource** (WSG) or a **registered service app**
   (iTwin: client_id/secret, scope `itwin-platform`, an iTwin id + Storage repo).
4. **Per second-plugin research spike** — before any of ACC/SharePoint/iTwin is built,
   map that provider's CRUD **and** its permission, approval, locking, retention, and
   attribute models (the write-guard + provenance capabilities), the same way WSG was
   analyzed.

## Consequences

- **Repo becomes a pnpm workspace.** `package.json` / `pnpm-workspace.yaml` gain a
  `packages:` glob and the existing app moves under the workspace. One-time churn;
  CI must run per-package.
- **Core gains five generic columns and one behavioral guard** (D5). This is the only
  core change and is justified by the decision to let the product respect upstream
  governance. The risk is enum drift — `external_state` must stay a small closed set;
  provider specifics belong in `external_metadata`, never in new enum values.
- **The abstraction is provisional until 7f.** The interface may need revision once a
  second provider lands; consumers of `connector-core` should expect a breaking
  change before its 1.0.
- **Runtime discovery is mandatory for WSG and cannot be shortcut.** The plugin must
  introspect MetaSchema rather than hardcode URLs/classes; this adds a discovery step
  to every WSG session and a dependency on the customer's deployment configuration.
- **Capability degradation must be observable.** When a plugin lacks a write-guard
  (e.g. iTwin Storage has no real lifecycle), the orchestrator proceeds but must log
  and surface the reduced safety — silent best-effort would let a push clobber a doc
  the framework simply couldn't check.
- **w:sdt anchors (ADR-004) must survive the DMS round-trip.** Most DMSs store the
  DOCX bytes verbatim, so anchors survive; any provider that transforms content
  (e.g. PDF rendition round-trips) degrades to Phase 3's position-based fallback —
  expose this as a per-provider caveat.
- **Connector ↔ core is HTTP, so it benefits from — and waits on — SpecR auth (#43).**
  Until then the connector talks to an unauthenticated local server, acceptable only
  for non-prod.

## Alternatives considered

- **A ProjectWise-specific connector (no framework).** Rejected: ProjectWise is one
  of several DMSs firms use; a bespoke connector would be rebuilt N times and would
  tempt PW-isms into shared code. The framework cost is small relative to the second
  integration.
- **Put the connector / a `/connectors` endpoint inside `specr` core.** Rejected:
  violates the DMS-agnostic constraint (ADR-002). The generic endpoint lives in
  `connector-core`.
- **A separate connector-owned mapping store (doc↔spec).** Rejected once D5 was
  chosen: mirroring `external_state` onto core already requires external linkage in
  core, so a second store would duplicate the source of truth.
- **Model provider richness directly in core** (real ProjectWise workflow states,
  ACLs, retention on the spec). Rejected: leaks provider specifics into core. Core
  carries only the generic `external_state` enum + opaque `external_metadata`.
- **Use the iTwin Storage API as the universal Bentley path.** Rejected as universal:
  hosted ProjectWise documents are not reachable via iTwin Storage; they remain
  behind WSG (D6). iTwin Storage is a distinct plugin for greenfield iTwin-native
  documents only.
