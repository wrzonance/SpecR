import {
  handleCreateCheckpoint,
  handleListCheckpoints,
  handleGetCheckpoint,
  handleGetPendingSummary,
  CreateCheckpointShape,
  CheckpointScopeShape,
  CheckpointIdShape,
  PendingSummaryShape,
} from './checkpoint-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

// ADR-052 D3/D4/D9 (issue #380, task 10) — registers the checkpoint and
// pending-summary tools. Each tool covers a spec-scoped and a project-scoped
// REST route (contract-map.ts OP_TO_TOOL), the get_reference_graph precedent.
export function registerCheckpointTools(reg: ToolRegistrar): void {
  reg.register(
    'create_checkpoint',
    {
      description:
        'Seal a spec — or every spec a project owns — at its current content_version(s) ' +
        '(the Word "accept changes" moment, ADR-052 D3/D4). Everything recorded after the ' +
        'latest checkpoint reads as pending until the next one. Provide exactly one of ' +
        'specId or projectId. actorLabel is REQUIRED — checkpoints.user_id is NOT NULL, so ' +
        '(unlike an ordinary paragraph write) there is no system-actor fallback.',
      inputSchema: CreateCheckpointShape,
    },
    handleCreateCheckpoint
  );
  reg.register(
    'list_checkpoints',
    {
      description:
        'List checkpoints sealed directly against a spec or a project, most recent first. ' +
        'Provide exactly one of specId or projectId. A spec-scoped list does NOT include ' +
        'project-scoped checkpoints that also covered it — see sealedByCheckpointId on ' +
        'get_pending_summary and get_paragraph_history for "which checkpoint most recently ' +
        'sealed this spec".',
      inputSchema: CheckpointScopeShape,
    },
    handleListCheckpoints
  );
  reg.register(
    'get_checkpoint',
    {
      description: 'Retrieve a single checkpoint by id.',
      inputSchema: CheckpointIdShape,
    },
    handleGetCheckpoint
  );
  reg.register(
    'get_pending_summary',
    {
      description:
        'Everything a spec — or every spec a project owns — has accumulated since its last ' +
        'checkpoint (ADR-052 D9). Counts DISTINCT pending paragraphs (never raw op count) and ' +
        'rolls them up by the actor of each paragraph’s LATEST pending edit. A spec never ' +
        'checkpointed reports its whole recorded history as pending. Provide exactly one of ' +
        'specId or projectId; packageId (project scope only) is echoed back for the caller’s ' +
        'own issuance-deadline framing and never scopes the query.',
      inputSchema: PendingSummaryShape,
    },
    handleGetPendingSummary
  );
}
