# SpecR Web UI Demo

This is a standalone reference client for the SpecR REST API. It lives under
`examples/` on purpose: the demo can drift or break when API endpoints change,
but it must not require API/backend changes under `src/`.

## Run

Start the API from the repo root, then run the demo server:

```bash
pnpm install
pnpm migrate
pnpm seed
pnpm build
PORT=3000 node dist/index.js
```

In a second terminal:

```bash
cd examples/web_ui_demo
cp .env.example .env      # first run only — then edit .env to taste (optional)
node server.mjs
```

Open `http://127.0.0.1:3001`.

`server.mjs` auto-loads `.env` from **this** folder for its configuration —
`OPENAI_API_KEY` / `OPENAI_MODEL`, `PORT`, and `SPECR_API_BASE`. `.env` is
gitignored; `.env.example` is the committed template documenting every setting. A
real shell/CI environment variable always overrides the file, so a one-off like
`PORT=3002 node server.mjs` still works.

The demo server serves the static files in this directory and proxies API calls
to `SPECR_API_BASE`. That avoids changing the real API server to serve demo
assets or add CORS just for this example.

## Workspace views

The nav bar switches between: **Project Spec Map** (drop specs, watch the
cross-reference web knit), **Editor** (full-page document editing), **Constellation**
(the project corpus as division solar systems), **TOC** builder, **Project
Settings**, **Library** (company + client masters), **Numbering**, **Report**
(the live coordination audit), **Submittal** (the submittal register), and
**Compose** (agent-driven grounded reporting).

### Editor view (#369)

The **Editor** tab is a WYSIWYG writing surface for one section at a time: a
project TOC rail grouped by MasterFormat division on the left, the live spec
sheet in the middle, and a section inspector on the right (outbound CITES /
inbound CITED BY, editability tallies when the API provides them).

- **Click into any text to edit it in place** — paragraphs, article and part
  headings alike. Changes save when you click away (`PATCH
  /specs/:id/paragraphs/:nodeId`); Escape also commits. A paragraph the
  editability program classified `locked` stays read-only and says so with a
  chip.
- **Tab / Shift+Tab indents and outdents the focused paragraph** through the
  CSI tier ladder with live renumbering — labels are render-derived, so the
  whole sheet renumbers instantly. `Shift+Tab` on a top-tier paragraph promotes
  it to an **article** (its following siblings become its children); an
  article's hover **⇥** demotes it back under the previous article.
- **Enter starts a new paragraph of the same CSI level** right below the
  focused one — a new empty article when pressed in an article heading —
  caret ready, sheet renumbered. (Text does not split at the caret; the
  current paragraph commits as-is.) Parts are the exception: CSI's three-part
  format is preserved.
- The API has no restructure (#371) or paragraph-creation (#372) endpoint
  yet, so Tab/Shift+Tab moves and Enter-drafts are held as an
  explicitly-labeled **LOCAL PREVIEW** (with a RESET) that re-applies over
  server truth — text edits on real paragraphs inside a preview still persist
  for real, and drafts wear a `DRAFT · LOCAL` tag.
- **Citations render as chips** inside the editable text — click to jump,
  **×** to remove (tracked references go through the removed-reference dialog;
  anything else asks a plain confirm first).
- **Add a section** by number in the rail — it resolves out of the project's
  source libraries (company + selected client masters) via
  `POST /projects/:id/specs`.
- **REMOVE SECTION** flags the open section instead of deleting it: it is
  struck in the rail and held in a review queue until you **CONFIRM REMOVAL**
  (which actually removes it from the project and lets the server recompute
  broken inbound references) or **RESTORE** it. Flags are demo-local staging —
  nothing changes server-side until confirmed.

### Constellation view (#369)

The **Constellation** tab draws the whole project corpus as one sky: each
division is a solar system whose umbrella section (`NN 00 00`) is the sun —
brighter the more other divisions cite into it — or a **black hole** when the
project defines no umbrella (click it to add one from your masters). Sections
orbit as planets sized by inbound citations; orphans get an amber dashed ring;
sections flagged in the Editor turn amber.

- **Citation sightlines** run planet-to-planet. A citation with no target in
  the project ends in a red ✕ (unresolved) or an amber ghost dot (the target
  is in a source library, one click from being added).
- **Hover a planet** to light its sightlines and dim the rest; **click a
  sightline** to open the citing paragraph in the Editor; **click a planet**
  for a detail panel (status, cites, cited-by, OPEN IN EDITOR).
- **Focus one system** via the SYSTEM select (or a portal): the division
  becomes a star-system view with portals to every system it trades citations
  with. Lane chips filter to CROSS-SYSTEM or BROKEN ONLY.
- The map reads the same client state as the Reference Web, so edits, flags,
  additions, and removals reshape it immediately.

### Coordination audit view (ADR-041)

The **Report** tab is a side-by-side audit: coordination findings on the left,
the spec they cite on the right — so a writer audits the whole project without
leaving the Report.

- **Click a finding** to open its section in the right pane and scroll to the
  exact cited paragraph, which is highlighted. Findings that carry a
  paragraph-level anchor (dangling cross-references, implied related sections,
  and the submittal product findings) land on the precise line; section-level
  findings open the section head.
- **Hover a finding** for a ‹ n/N › prev / next pill — the same control the
  Project Spec Map uses for citations. Stepping selects the next finding, scrolls
  it into view, and drives the spec pane in sync. Arrow keys step once a finding
  is focused, and the counter is announced to screen readers.
- **Navigation is bidirectional** — clicking a paragraph or a citation in the
  spec pane highlights the finding that points at it.
- Drag the divider (or focus it and press ← / →) to re-balance the split; it
  stacks to a single column on narrow screens.
- Each finding group collapses via a rotating chevron; the whole header row is
  the toggle, with `aria-expanded` state and a smooth open/close.

The finding↔paragraph link reuses the paragraph UUID already surfaced as
`data-node-id` — no new anchor scheme and no backend change. See
`docs/adr/041-audit-view-paragraph-sync.md`.

### Numbering profiles (#299)

The **Numbering** view manages a library's numbering profiles — the outline
scheme a firm or client writes to: how many Parts a section has, which Word
outline level the Articles start on, and the label style (commercial
`1.01 / A. / 1.` vs all-numeric `1.1 / 1.1.1`). It supports per-library
create/delete and a **read-a-sample-document** tool that shows the scheme
inferred from a `.docx` without saving it (`POST /numbering-profiles/snapshot`).
Applying a profile at parse time is a `POST /parse` capability
(`numberingProfileId`); the demo's library-import flow does not surface it yet.

## Ask SpecR — MCP chat sidebar (optional)

The **💬 Ask SpecR** button opens an assistant that answers questions about your
loaded specs by calling SpecR's **MCP** tools (`POST /mcp`). The browser holds no
key: it POSTs the conversation to the demo server's `/chat` endpoint, which runs
the OpenAI tool-calling loop and bridges each tool call to the MCP endpoint.

It is **off until you provide a key** — without one the sidebar shows a clear
"not configured" note. Enable it by setting `OPENAI_API_KEY` in `.env` (this
folder):

```ini
# examples/web_ui_demo/.env
OPENAI_API_KEY=sk-...                       # required — stays server-side, never sent to the browser
OPENAI_MODEL=gpt-5.4                         # optional (default gpt-4o-mini; any tool-calling model)
OPENAI_BASE_URL=https://api.openai.com/v1   # optional — point at an OpenAI-compatible server
```

Restart `node server.mjs` after editing `.env`. The startup log prints which
config file it loaded and whether the chat bridge is enabled.

The bridge auto-discovers every MCP tool via `tools/list`, so it stays in sync as
SpecR adds tools. No admin controls or per-user permissions — it's an MVP.

## Compose — agent-driven grounded reporting (#353)

The **Compose** tab is the demo's flagship showcase of SpecR's differentiator:
**deterministic-first, not RAG** (see `ARCHITECTURE.md` → "Deterministic-First:
Grounded Data, Not RAG"). Instead of a deterministic button, an LLM agent _drives_
report composition — it calls SpecR's grounded MCP tools, gets computed ground
truth, and synthesizes a cited narrative. It appears here precisely because this
is where an agent beats a button: multi-spec / cross-project synthesis, natural-
language slicing, and composing several grounded reports into one deliverable.
Everything a single button already does stays a button.

Type a request (or pick an example), press **Compose report**, and:

- The browser POSTs to the demo server's `/report` endpoint, which runs a
  **read-only** OpenAI tool-calling loop over the MCP tools and streams progress
  back as newline-delimited JSON.
- **The grounding is shown.** Each grounded tool call streams into the left column
  as a live step ("Reading the coordination report…", "Comparing 2 specs…").
- **Every claim is citable.** The composed narrative lists a **Sources** panel of
  click-through chips — each traces to a real section + paragraph UUID and opens it
  in the **Report** audit pane. Citations come deterministically from each tool's
  `_meta['specr/anchors']`, not from parsing the model's prose.
- **Determinism where it counts.** The _facts_ are computed by the endpoints; only
  the wording varies between runs, so **Regenerate** re-runs the same request and
  reproduces the same findings.
- **Graceful "not present."** Grounded tools return real empties; the agent is
  instructed to say "not present" rather than fabricate.
- **Cost/scope is bounded and surfaced.** A meter shows rounds · grounded calls ·
  ~tokens; the loop is capped (rounds, tool calls, token budget) so the
  "hundreds of DOCX" corpus case can't run away.
- **Read-only by construction.** The composer is handed only tools the MCP server
  flags `readOnlyHint` — it physically cannot write or edit. That is this demo's
  answer to the human-in-the-loop-for-writes concern; edits stay in the deterministic
  views and the free-form **Ask SpecR** chat (which keeps the read+write tier).

Compose uses the **same** `OPENAI_API_KEY` as Ask SpecR (above) and is likewise
**off until you provide a key** — without one, pressing Compose shows the same
"not configured" note. The key stays server-side; the browser never sees it.

**Not yet: the PDF.** The vision includes a grounded **PDF artifact** of the
composed report. That depends on PDF egress (issue #352), which is still open, so
the **Download PDF** button ships **disabled**, with a tooltip that points at the
same issue. The cited on-screen report is the deliverable for now.

## One-Command Demo Launchers

`Start-SpecR.sh` and `Start-SpecR.bat` are convenience wrappers for local demos.
They build and start the API from the repo root, then run `server.mjs` from this
directory. `Start-SpecR.sh` uses an existing `pnpm >=11` or activates pnpm 11
through Corepack when needed.

### Behind a corporate proxy (Windows)

`Start-SpecR.bat` handles the two ways `pnpm install` fails on a locked-down
corporate machine — the registry is unreachable (`ERR_PNPM_META_FETCH_FAIL`) or
TLS is intercepted by SSL inspection (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`):

- **Proxy:** honors `HTTPS_PROXY` / `HTTP_PROXY` if set, otherwise auto-detects
  the Windows system proxy. Loopback (the API health check) always bypasses it.
- **TLS:** trusts an explicit cert via `NODE_EXTRA_CA_CERTS` or `SPECR_CA_CERT`
  (a `.pem` path); otherwise exports the machine's own certificate store — which
  already contains the corporate root CA — and trusts that.

Override as needed before launching, e.g. in PowerShell:

```powershell
$env:HTTPS_PROXY = 'http://proxy.corp.example:8080'
$env:SPECR_CA_CERT = 'C:\path\to\corp-root.pem'
.\Start-SpecR.bat
```

As a debug-only last resort, `SPECR_INSECURE_TLS=1` disables TLS verification
entirely — never leave it on.

### Database (Windows)

`Start-SpecR.sh` and `Start-SpecR.bat` need PostgreSQL. If nothing is listening
on the configured default port and you did not set `DATABASE_URL`, the launcher
auto-starts the bundled `docker compose` service on a free host port and points
the API at that port via `DATABASE_URL`. The Unix launcher also avoids the chosen
API and web demo ports when selecting the Docker PostgreSQL host port.

- Set `DATABASE_URL` to use your own/remote server instead; the launcher then
  only verifies the connection and never starts Docker.
- With no Docker and no reachable database it stops with a clear message instead
  of a raw connection-refused stack trace.
