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
  // The registered inputSchema now uses SubmittalRegisterBodySchema.extend()
  // (#550 F3), so the SDK's own tools/call validation already enforces the
  // object-level .check() duplicate-id refinement before this handler runs —
  // a duplicate call surfaces as an SDK "Input validation error" isError
  // result and never reaches this line. This safeParse is a defensive
  // backstop for any caller that invokes this handler directly, outside the
  // SDK-mediated tools/call path.
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
