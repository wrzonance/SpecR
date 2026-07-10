import type { Config } from './env.js';

// Minimal logger shape this module needs, so it stays decoupled from pino. The
// production `logger` (pino.Logger) satisfies it structurally.
export interface WarnLogger {
  warn(message: string): void;
}

export interface ExposureWarningInput {
  authConfigured: boolean;
  // Raw MCP_ALLOWED_TIERS value (already env-validated as a comma list of known tiers).
  mcpTiers: string;
}

/**
 * Whether any authentication mechanism is configured.
 *
 * Pre-#43 this is always false: the REST + MCP surface ships unauthenticated by
 * design (auth is phased in via #381 identity → #43 JWT/org isolation). This is the
 * single seam #43 flips — once auth config exists it detects it here and returns
 * true, which silences the boot warning automatically. `config` is unused today
 * (hence `_config`) but kept in the signature as that detection point.
 */
export function isAuthConfigured(_config: Config): boolean {
  return false;
}

// The MCP tier gate governs only MCP tools; REST is always write-capable pre-#43.
function mcpIsWriteCapable(mcpTiers: string): boolean {
  const tiers = mcpTiers
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tiers.includes('write') || tiers.includes('destructive');
}

/**
 * Build the boot-time exposure warning, or null when none is warranted.
 *
 * Returns a warning whenever the server is unauthenticated, because REST is always
 * write-capable pre-#43 — even with MCP locked to `read` an operator has exposed
 * unauthenticated writes. The message names both surfaces and softens to REST-only
 * when MCP is read-only. Returns null once auth is configured.
 */
export function buildUnauthenticatedExposureWarning(input: ExposureWarningInput): string | null {
  if (input.authConfigured) return null;

  const surfaces = mcpIsWriteCapable(input.mcpTiers)
    ? 'write-capable REST and MCP'
    : 'a write-capable REST API; MCP is read-only';

  return (
    `SpecR is running WITHOUT authentication with ${surfaces} ` +
    `(MCP tiers: ${input.mcpTiers}) — do not expose beyond a trusted network. See issue #43.`
  );
}

// Emit the exposure warning once via the logger. No-op when auth is configured.
export function logStartupSecurityWarning(log: WarnLogger, input: ExposureWarningInput): void {
  const message = buildUnauthenticatedExposureWarning(input);
  if (message) log.warn(message);
}
