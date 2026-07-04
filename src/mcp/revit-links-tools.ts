import { z } from 'zod';
import { getProjectRevitLinks, ProjectNotFoundError } from '../db/index.js';
import type { ToolRegistrar } from './tool-registry.js';

type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolResult = ToolOk | ToolError;

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

export async function handleListRevitLinks({
  projectId,
  revitInstanceId,
  specId,
}: {
  projectId: string;
  revitInstanceId?: string | undefined;
  specId?: string | undefined;
}): Promise<ToolResult> {
  try {
    const filter: { revitInstanceId?: string; specId?: string } = {};
    if (revitInstanceId !== undefined) filter.revitInstanceId = revitInstanceId;
    if (specId !== undefined) filter.specId = specId;
    const inventory = await getProjectRevitLinks(projectId, filter);
    return { content: [{ type: 'text' as const, text: JSON.stringify(inventory, null, 2) }] };
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return toolErr(err.message);
    return toolErr('Internal error — revit link inventory failed');
  }
}

/** Read-only Revit link inventory (#103), contract-bound to GET /projects/:id/revit-links. */
export function registerRevitLinksTools(reg: ToolRegistrar): void {
  reg.register(
    'list_revit_links',
    {
      description:
        'Project Revit link inventory: which model elements (revit_instance_id) link ' +
        'to which spec sections, and which project specs have no model backing. Returns ' +
        'two pivots — byElement (element->sections) and bySpec (section->elements) — plus ' +
        'summary counts (specsWithoutModelBacking, elementCount, mappingCount). Optional ' +
        'revitInstanceId or specId narrows the pivots; the summary stays project-wide. ' +
        'Read-only. Requires a projectId (see list_projects).',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        revitInstanceId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional Revit element instance id to filter the pivots'),
        specId: z.uuid().optional().describe('Optional project spec UUID to filter the pivots'),
      },
    },
    handleListRevitLinks
  );
}
