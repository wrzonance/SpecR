// src/mcp/tool-result.ts
// Canonical MCP tool-result shapes, shared by every handler module so the
// ok/error shapes cannot drift between them. ToolOk carries the optional _meta
// superset (some handlers attach navigation anchors under _meta); handlers that
// never set _meta are still structurally compatible.
export type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
export type ToolOk = {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly _meta?: Record<string, unknown>;
};
export type ToolResult = ToolOk | ToolError;
