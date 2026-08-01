// examples/web_ui_demo/env-file.mjs
// Loads the demo's own .env (examples/web_ui_demo/.env) into process.env.
// Shared by server.mjs and preflight.mjs so both resolve provider settings from
// exactly the same source — a preflight reading a different file than the server
// would be worse than no preflight at all.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// A missing .env is fine (defaults apply). A real shell/CI environment variable
// always wins over a value in the file, so the one-command launchers (which pass
// PORT/SPECR_API_BASE inline) keep control of the ports while .env supplies the
// LLM provider settings.
export function loadLocalEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false; // no local .env — rely on the real environment + defaults
  }
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
