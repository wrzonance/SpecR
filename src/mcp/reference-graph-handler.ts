import {
  getReferenceGraph,
  ProjectNotFoundError,
  LibraryNotFoundError,
  type GraphScope,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

// Exactly one of projectId / libraryId picks the scope; neither or both is an error.
function resolveScope(projectId?: string, libraryId?: string): GraphScope | ToolError {
  if (projectId !== undefined && libraryId === undefined) return { kind: 'project', id: projectId };
  if (libraryId !== undefined && projectId === undefined) return { kind: 'library', id: libraryId };
  return toolErr('Provide exactly one of projectId or libraryId');
}

export async function handleGetReferenceGraph({
  projectId,
  libraryId,
  includeAnchors,
}: {
  projectId?: string | undefined;
  libraryId?: string | undefined;
  includeAnchors?: boolean | undefined;
}): Promise<ToolResult> {
  const scope = resolveScope(projectId, libraryId);
  if ('isError' in scope) return scope;
  try {
    const graph = await getReferenceGraph(scope, { includeAnchors: includeAnchors ?? false });
    return { content: [{ type: 'text' as const, text: JSON.stringify(graph, null, 2) }] };
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) {
      return toolErr(err.message);
    }
    logger.error({ err }, 'mcp tool get_reference_graph failed');
    return toolErr('Internal error — reference graph failed');
  }
}
