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
PORT=3001 SPECR_API_BASE=http://127.0.0.1:3000 node server.mjs
```

Open `http://127.0.0.1:3001`.

The demo server serves the static files in this directory and proxies API calls
to `SPECR_API_BASE`. That avoids changing the real API server to serve demo
assets or add CORS just for this example.

## One-Command Demo Launchers

`Start-SpecR.sh` and `Start-SpecR.bat` are convenience wrappers for local demos.
They build and start the API from the repo root, then run `server.mjs` from this
directory. They assume PostgreSQL and `pnpm` are already available.

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

`Start-SpecR.bat` needs PostgreSQL. If nothing is listening on the configured
port it auto-starts the bundled `docker compose` service on the first free host
port — so it never collides with an existing Postgres — and points the API at
that port via `DATABASE_URL`.

- Set `DATABASE_URL` to use your own/remote server instead; the launcher then
  only verifies the connection and never starts Docker.
- With no Docker and no reachable database it stops with a clear message instead
  of a raw connection-refused stack trace.
