import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { McpError } from './error.js';
import { TOOL_TIERS, tierAnnotations, type ToolTier } from './capabilities.js';

interface ToolConfig<Args extends ZodRawShape> {
  readonly description: string;
  readonly inputSchema?: Args;
  readonly annotations?: ToolAnnotations;
}

export interface ToolRegistrar {
  register<Args extends ZodRawShape>(
    name: string,
    config: ToolConfig<Args>,
    handler: ToolCallback<Args>
  ): void;
  readonly declared: readonly string[];
}

export function createRegistrar(
  server: McpServer,
  allowedTiers: ReadonlySet<ToolTier>
): ToolRegistrar {
  const declared: string[] = [];
  return {
    declared,
    register(name, config, handler) {
      const tier = TOOL_TIERS.get(name);
      if (tier === undefined) {
        throw new McpError(
          `MCP tool "${name}" has no capability tier — add it to TOOL_TIERS in capabilities.ts`
        );
      }
      declared.push(name);
      if (!allowedTiers.has(tier)) return; // gated: absent ⇒ not listed, not callable
      server.registerTool(
        name,
        { ...config, annotations: { ...tierAnnotations(tier), ...config.annotations } },
        handler
      );
    },
  };
}
