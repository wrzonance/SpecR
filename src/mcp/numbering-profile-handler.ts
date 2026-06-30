// src/mcp/numbering-profile-handler.ts
import { getEffectiveNumberingProfile } from '../db/index.js';
import { McpError } from './error.js';
import { logger } from '../lib/logger.js';

type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolResult = ToolOk | ToolError;

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

export async function handleGetNumberingProfile({
  specId,
}: {
  specId: string;
}): Promise<ToolResult> {
  try {
    // Single lookup: getEffectiveNumberingProfile returns null when the spec does
    // not exist — no separate full-tree existence fetch, so no needless paragraph
    // load and no delete-between-awaits race that could return a missing spec.
    const profile = await getEffectiveNumberingProfile(specId);
    if (profile === null) return toolErr(`Spec not found: id=${specId}`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }] };
  } catch (err) {
    const wrapped = new McpError(`get_numbering_profile failed for spec ${specId}`, { cause: err });
    logger.error({ err: wrapped }, 'mcp tool get_numbering_profile failed');
    return toolErr('Internal error — numbering profile retrieval failed');
  }
}
