// src/mcp/sessions.ts
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '../lib/logger.js';

export interface McpSession {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

/**
 * Owns the lifecycle of stateful MCP sessions.
 *
 * The `@modelcontextprotocol/sdk` transport binds exactly one session per
 * instance once `sessionIdGenerator` is set: it mints the id on the first
 * `initialize`, then validates every later request's `mcp-session-id` header
 * against that id. So a session = one long-lived transport+server pair, keyed
 * by the id the transport itself generates. Stateless callers never enter this
 * store — they get a fresh transport per request in the route handler.
 */
export class McpSessionStore {
  private readonly sessions = new Map<string, McpSession>();

  /** Look up a live session by the id carried in the `mcp-session-id` header. */
  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Number of live sessions — for tests and observability. */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Create a stateful transport+server for a fresh `initialize` request. The
   * transport registers itself in the store under the minted id once the SDK
   * fires `onsessioninitialized`, and removes itself on `onsessionclosed`.
   */
  createStateful(makeServer: () => McpServer): McpSession {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, { server, transport });
      },
      onsessionclosed: (sessionId: string) => {
        this.sessions.delete(sessionId);
      },
    });
    return { server, transport };
  }

  /**
   * Terminate a session: close its transport and server, drop the Map entry.
   * Returns false when the id is unknown (caller maps that to 404).
   */
  async delete(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    // Delete first so a concurrent request cannot reuse a closing session.
    this.sessions.delete(sessionId);
    const results = await Promise.allSettled([session.transport.close(), session.server.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn({ err: result.reason, sessionId }, 'mcp session cleanup failed');
      }
    }
    return true;
  }
}

/** Connect a server to its transport, satisfying the SDK's strict Transport type. */
export async function connectSession(session: McpSession): Promise<void> {
  // Cast to Transport to satisfy strict SDK types — onclose optionality mismatch in SDK v1.
  await session.server.connect(session.transport as Transport);
}
