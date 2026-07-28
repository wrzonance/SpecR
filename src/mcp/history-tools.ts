import {
  handleGetHistoryDiff,
  handleGetParagraphHistory,
  handleGetSpecHistory,
  HistoryDiffShape,
  ParagraphHistoryShape,
  SpecHistoryShape,
} from './history-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerHistoryTools(reg: ToolRegistrar): void {
  reg.register(
    'get_paragraph_history',
    {
      description:
        'Read one paragraph’s history. By default returns tier-1 coalesced sessions oldest-' +
        'first (ADR-052 D3/D9) — each session carries sealedByCheckpointId/sealedContentVersion ' +
        '(the checkpoint that sealed it, or null if still pending) plus its raw entries[] span. ' +
        'raw: true returns tier-0 raw iterations instead. By default a project copy starts at ' +
        'derive; includeOrigin prepends its master paragraph’s pre-derive iterations.',
      inputSchema: ParagraphHistoryShape,
    },
    handleGetParagraphHistory
  );
  reg.register(
    'get_spec_history',
    {
      description:
        'Read a spec’s content-version timeline with edited/inserted/removed counts and immutable ' +
        'derive/revision milestones. packageId narrows revision milestones for issuance review.',
      inputSchema: SpecHistoryShape,
    },
    handleGetSpecHistory
  );
  reg.register(
    'get_history_diff',
    {
      description:
        'Compare two stored states of one spec by content version, package revision UUID, ' +
        '`checkpoint:<uuid>` (from get_checkpoint/list_checkpoints, ADR-052 D3/D9), origin, or ' +
        'current. Returns row-level added/removed/modified text; word highlighting is client-side.',
      inputSchema: HistoryDiffShape,
    },
    handleGetHistoryDiff
  );
}
