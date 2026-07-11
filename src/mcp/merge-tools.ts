import { handleApplyMerge, ApplyMergeShape } from './merge-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerMergeTools(reg: ToolRegistrar): void {
  reg.register(
    'apply_merge',
    {
      description:
        'Apply accepted changes from a spec diff (ADR-009 merge). Pass specId, the DiffResult ' +
        'from get_spec_diff, and accept: the UUIDs of the changes to apply; rejected entries are ' +
        'discarded by omission. Accepted modified/conflict changes update paragraph text; ' +
        'accepted added changes insert the new paragraph after their afterUuid anchor (nearest ' +
        'preceding controlled paragraph — an addition with no anchor, or one anchored on a ' +
        'structural part/article/note node, is rejected); accepted ' +
        'deleted changes reversibly vanish the paragraph (ADR-022, only body paragraphs are ' +
        'removable this way). The spec’s contentVersion is bumped at most once per call, only ' +
        'when at least one change is actually applied. ' +
        'Supply expectedVersion (the contentVersion the diff was ' +
        'computed against) for an optimistic-concurrency check — a stale value is rejected. ' +
        'Returns { applied, rejected }.',
      inputSchema: ApplyMergeShape,
    },
    handleApplyMerge
  );
}
