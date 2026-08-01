// src/lib/parse-extensions.ts
// Single source of truth for which file extensions the parse pipeline accepts.
// Before #567, src/api/parse.ts and src/mcp/parse-document-handler.ts each kept
// their own hand-written allowlist; the MCP copy had drifted (missing .pdf),
// silently rejecting a format REST and openapi.yaml both document as supported.
// Both call sites now read this one constant so the two surfaces can't diverge
// again.
export const ALLOWED_PARSE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.docx',
  '.pdf',
  '.sec',
  '.txt',
]);
