// src/mcp/tool-result.ts
// Canonical MCP tool-result shapes, shared by every handler module so the
// ok/error shapes cannot drift between them. ToolOk carries the optional _meta
// superset (some handlers attach navigation anchors under _meta); handlers that
// never set _meta are still structurally compatible.
//
// ToolError.structuredContent (ADR-081) is an OPTIONAL machine-readable
// payload alongside the always-present human-readable `content` text — added
// so conflict-class failures (e.g. a 409-equivalent lock contention) can
// carry fields like `holder`/`expiresAt` without an agent having to regex
// prose. Mirrors the MCP protocol's own `structuredContent` result field
// name for forward-compat with clients that already read it on success.
export type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
};
export type ToolOk = {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly _meta?: Record<string, unknown>;
};
export type ToolResult = ToolOk | ToolError;
