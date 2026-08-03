import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from './error.js';
import { TOOL_TIERS, tierAnnotations, type ToolTier } from './capabilities.js';

/** A tool's declared arguments: the usual raw `{ name: zodType }` shape, or a
 *  whole Zod object schema. The schema form exists because a raw shape LOSES
 *  any `.strict()` on the schema it came from — the SDK rebuilds it with
 *  `z.object(shape)`, whose default behavior silently STRIPS unknown keys. For
 *  a tool whose behavior is gated on an optional field, that turns a caller's
 *  typo into a no-op instead of an error (see generate_docx in tools.ts, and
 *  the `mdoe`/`mode` note in ast/generate-schemas.ts). Passing the object
 *  schema through unchanged keeps strict mode, and the SDK then rejects the
 *  unknown key with an InvalidParams error. */
export type ToolInputSchema = ZodRawShapeCompat | AnySchema;

interface ToolConfig<Args extends ToolInputSchema> {
  readonly description: string;
  readonly inputSchema?: Args;
  readonly annotations?: ToolAnnotations;
}

/** What `registerTools()` (tools.ts) hands back once every tool has been
 *  declared: the full tool-name list plus each tool's raw inputSchema, keyed
 *  by name. Mirrors `ToolRegistrar.schemas` below — see its doc comment for
 *  why capture is unconditional. */
export interface RegisteredTools {
  readonly names: readonly string[];
  readonly schemas: ReadonlyMap<string, ToolInputSchema>;
}

export interface ToolRegistrar {
  register<Args extends ToolInputSchema>(
    name: string,
    config: ToolConfig<Args>,
    handler: ToolCallback<Args>
  ): void;
  readonly declared: readonly string[];
  /** Every declared tool's raw inputSchema, keyed by name. Populated BEFORE
   *  the tier gate in `register()` below, so contract-level introspection
   *  (comparing a tool's arguments against its mapped OpenAPI operation) sees
   *  every tool's shape regardless of which tiers a given MCP_ALLOWED_TIERS
   *  runtime config admits. A tool with no declared inputSchema has no entry. */
  readonly schemas: ReadonlyMap<string, ToolInputSchema>;
}

export function createRegistrar(
  server: McpServer,
  allowedTiers: ReadonlySet<ToolTier>
): ToolRegistrar {
  const declared: string[] = [];
  const schemas = new Map<string, ToolInputSchema>();
  return {
    declared,
    schemas,
    register(name, config, handler) {
      const tier = TOOL_TIERS.get(name);
      if (tier === undefined) {
        throw new McpError(
          `MCP tool "${name}" has no capability tier — add it to TOOL_TIERS in capabilities.ts`
        );
      }
      declared.push(name);
      if (config.inputSchema !== undefined) {
        schemas.set(name, config.inputSchema);
      }
      if (!allowedTiers.has(tier)) return; // gated: absent ⇒ not listed, not callable
      // Tier-derived hints are authoritative: spread them LAST so a tool's own
      // config.annotations can add annotations (title, openWorldHint) but can never
      // override readOnlyHint/destructiveHint and mis-signal a destructive tool as safe.
      server.registerTool(
        name,
        { ...config, annotations: { ...config.annotations, ...tierAnnotations(tier) } },
        handler
      );
    },
  };
}
