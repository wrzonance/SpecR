import {
  getSubmittalRegister,
  SubmittalRegisterProjectNotFoundError,
  SubmittalRegisterSpecNotInProjectError,
} from '../db/index.js';

type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolResult = ToolOk | ToolError;

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
