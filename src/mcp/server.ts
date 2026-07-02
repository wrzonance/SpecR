// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { json } from 'express';
import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { McpSessionStore, connectSession } from './sessions.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/env.js';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'specr', version: '0.1.0' });
  // Capability tiers gate which tools are exposed (src/mcp/capabilities.ts). Default read,write.
  registerTools(server);
  registerResources(server);
  return server;
}

/** Per-request stateless transport: fresh instance, disposed when the response finishes. */
async function handleStateless(req: Request, res: Response): Promise<void> {
  // Omit sessionIdGenerator entirely to enable stateless mode (exactOptionalPropertyTypes).
  // Cast to Transport to satisfy strict SDK types — onclose optionality mismatch in SDK v1.
  const transport = new StreamableHTTPServerTransport({});
  const server = createMcpServer();
  await server.connect(transport as Transport);
  res.on('finish', () => {
    void (async (): Promise<void> => {
      const results = await Promise.allSettled([transport.close(), server.close()]);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn({ err: result.reason }, 'mcp transport cleanup failed');
        }
      }
    })();
  });
  await transport.handleRequest(req, res, req.body);
}

/**
 * Route a POST /mcp request. Three paths:
 *  1. `mcp-session-id` header matches a live session → reuse its transport.
 *  2. No header + `initialize` body → mint a stateful session (store owns its lifecycle).
 *  3. Otherwise → stateless, fresh per request (the legacy default).
 */
async function handlePost(store: McpSessionStore, req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId === 'string') {
    const session = store.get(sessionId);
    if (session === undefined) {
      res.status(404).json({ success: false, error: 'unknown or expired MCP session' });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }
  if (isInitializeRequest(req.body)) {
    const session = store.createStateful(createMcpServer);
    await connectSession(session);
    await session.transport.handleRequest(req, res, req.body);
    return;
  }
  await handleStateless(req, res);
}

export function registerMcpRoutes(
  app: Express,
  options?: { readonly rateLimitMax?: number }
): void {
  // One session store per registration — outlives individual requests, scoped to this app.
  const sessions = new McpSessionStore();
  const mcpRateLimit = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    // Read live per request (see src/lib/env.ts). The optional override lets integration
    // suites raise the ceiling above the configured default without touching env.
    limit: () => options?.rateLimitMax ?? config.RATE_LIMIT_MCP_MAX,
    // Unlike the REST limiter this does NOT skip in test mode — the rate-limit test
    // exercises the live limiter, and integration suites raise the ceiling via rateLimitMax.
    skip: () => config.DISABLE_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'too many MCP requests — please wait before retrying' },
  });
  app.post('/mcp', mcpRateLimit, json({ limit: '15mb' }), async (req, res) => {
    // AUTH HOOK: validate Authorization: Bearer <token> here before connecting transport.
    // Same token validation as REST middleware. Reject 401 if invalid.
    // Write tools especially depend on this gate — add when REST auth is implemented.
    try {
      await handlePost(sessions, req, res);
    } catch (err) {
      logger.error({ err }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'internal server error' });
      }
    }
  });

  // GET /mcp: SSE streams (server→client notifications) are not exposed yet — Phase 5
  // streaming will wire this to a live session. Until then it is a 405 stub.
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ success: false, error: 'SSE streams not supported' });
  });

  // DELETE /mcp: terminate the session named by the mcp-session-id header.
  app.delete('/mcp', (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') {
      res.status(400).json({ success: false, error: 'mcp-session-id header required' });
      return;
    }
    void (async (): Promise<void> => {
      try {
        const terminated = await sessions.delete(sessionId);
        if (!terminated) {
          res.status(404).json({ success: false, error: 'unknown or expired MCP session' });
          return;
        }
        res.status(204).end();
      } catch (err) {
        logger.error({ err }, 'mcp session termination failed');
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'internal server error' });
        }
      }
    })();
  });
}
