// src/mcp/numbering-profile-handler.ts
import { getSpecTree, getEffectiveNumberingProfile } from '../db/index.js';
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
    const spec = await getSpecTree(specId);
    if (!spec) return toolErr(`Spec not found: id=${specId}`);
    const profile = await getEffectiveNumberingProfile(specId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_numbering_profile failed');
    return toolErr('Internal error — numbering profile retrieval failed');
  }
}
