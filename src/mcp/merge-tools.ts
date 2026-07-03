import { handleApplyMerge, ApplyMergeShape } from './merge-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerMergeTools(reg: ToolRegistrar): void {
  reg.register(
    'apply_merge',
    {
      description:
        'Apply accepted changes from a spec diff (ADR-009 merge). Pass specId, the DiffResult ' +
        'from get_spec_diff, and accept: the UUIDs of the changes to apply; rejected entries are ' +
        'discarded by omission. Accepted modified/conflict changes update paragraph text; the ' +
        'spec’s contentVersion is bumped only when at least one change is actually applied. ' +
        'Supply expectedVersion (the contentVersion the diff was ' +
        'computed against) for an optimistic-concurrency check — a stale value is rejected. ' +
        'Returns { applied, rejected }.',
      inputSchema: ApplyMergeShape,
    },
    handleApplyMerge
  );
}
