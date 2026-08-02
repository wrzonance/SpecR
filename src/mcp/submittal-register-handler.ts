import { SubmittalRegisterBodySchema } from '../ast/index.js';
import {
  getSubmittalRegister,
  SubmittalRegisterProjectNotFoundError,
  SubmittalRegisterSpecNotInProjectError,
} from '../db/index.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

export async function handleSubmittalRegister({
  projectId,
  specIds,
}: {
  projectId: string;
  specIds: readonly string[];
}): Promise<ToolResult> {
  // The MCP tool schema spreads SubmittalRegisterBodySchema.shape into a
  // ZodRawShape for the SDK's inputSchema, which drops the schema's
  // object-level .check() duplicate-id refinement. Re-validate here so
  // duplicate specIds still surface the shared schema's own message instead
  // of falling through to getSubmittalRegister's "not in project" check.
  const validated = SubmittalRegisterBodySchema.safeParse({ specIds });
  if (!validated.success) {
    return toolErr(validated.error.issues[0]?.message ?? 'invalid specIds');
  }

  try {
    const report = await getSubmittalRegister(projectId, specIds);
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (
      err instanceof SubmittalRegisterProjectNotFoundError ||
      err instanceof SubmittalRegisterSpecNotInProjectError
    ) {
      return toolErr(err.message);
    }
    return toolErr('Internal error — submittal register failed');
  }
}
