import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRegistrar } from './tool-registry.js';
import { McpError } from './error.js';

const ok = () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('createRegistrar', () => {
  it('registers a tool whose tier is allowed and records it', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const reg = createRegistrar(server, new Set(['read']));
    reg.register('get_spec', { description: 'read a spec', inputSchema: { id: z.uuid() } }, ok);
    expect(reg.declared).toContain('get_spec');
  });

  it('records but does NOT register a tool whose tier is gated off', () => {
    const server = new McpServer({ name: 't', version: '0' });
    // Spy on the SDK method to detect real registration.
    const spy = vi.spyOn(server, 'registerTool');
    const reg = createRegistrar(server, new Set(['read'])); // write NOT allowed
    reg.register(
      'parse_document',
      { description: 'write', inputSchema: { filename: z.string() } },
      ok
    );
    expect(reg.declared).toContain('parse_document'); // still declared…
    expect(spy).not.toHaveBeenCalled(); // …but never registered → not listable, not callable
  });

  it('throws McpError for a tool with no declared tier', () => {
    const server = new McpServer({ name: 't', version: '0' });
    const reg = createRegistrar(server, new Set(['read', 'write']));
    expect(() => reg.register('totally_new_tool', { description: 'x' }, ok)).toThrow(McpError);
  });
});
