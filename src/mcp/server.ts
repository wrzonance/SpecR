// src/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { logger } from '../lib/logger.js';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'specr', version: '0.1.0' });
  registerTools(server);
  registerResources(server);
  return server;
}

export function registerMcpRoutes(app: Express): void {
  app.post('/mcp', async (req, res) => {
    // AUTH HOOK: validate Authorization: Bearer <token> here before connecting transport.
    // Same token validation as REST middleware. Reject 401 if invalid.
    // Write tools especially depend on this gate — add when REST auth is implemented.
    try {
      // Omit sessionIdGenerator entirely to enable stateless mode (exactOptionalPropertyTypes).
      // Cast to Transport to satisfy strict SDK types — onclose optionality mismatch in SDK v1.
      const transport = new StreamableHTTPServerTransport({});
      const server = createMcpServer();
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, req.body);
      res.on('finish', () => {
        void transport.close();
      });
    } catch (err) {
      logger.error({ err }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal server error' });
      }
    }
  });

  // GET /mcp and DELETE /mcp: stubs for stateful session upgrade (Phase 5+).
  // In stateless mode these are unused — clients only POST.
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ error: 'stateless mode: SSE streams not supported' });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json({ error: 'stateless mode: no sessions to terminate' });
  });
}
