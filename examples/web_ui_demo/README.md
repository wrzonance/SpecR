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
