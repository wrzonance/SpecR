import {
  handleUpdateSpec,
  handleFinalizeSpec,
  handleReopenSpec,
  handleRestoreSpec,
  handleDeleteSpec,
  SpecIdShape,
  UpdateSpecShape,
} from './spec-lifecycle-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerSpecLifecycleTools(reg: ToolRegistrar): void {
  registerSpecEditTools(reg);
  registerSpecCustodyTools(reg);
}

function registerSpecEditTools(reg: ToolRegistrar): void {
  reg.register(
    'update_spec',
    {
      description:
        'Update a spec’s metadata (title and/or section number). Provide specId and at ' +
        'least one of: title, section. Returns the updated spec.',
      inputSchema: UpdateSpecShape,
    },
    handleUpdateSpec
  );

  reg.register(
    'finalize_spec',
    {
      description:
        'Finalize a spec’s onboarding: move it from review → active (ADR-022 D6). Idempotent — ' +
        'finalizing an already-active spec is a success. Returns the new onboardingStatus.',
      inputSchema: SpecIdShape,
    },
    handleFinalizeSpec
  );

  reg.register(
    'reopen_spec',
    {
      description:
        'Reopen a finalized spec for editing: move it from active → review (ADR-022 D6). ' +
        'Idempotent — reopening an already-in-review spec is a success. Returns the new onboardingStatus.',
      inputSchema: SpecIdShape,
    },
    handleReopenSpec
  );
}

function registerSpecCustodyTools(reg: ToolRegistrar): void {
  reg.register(
    'restore_spec',
    {
      description:
        'Restore a withdrawn library-master spec (ADR-030). Idempotent for an already-active ' +
        'master. A project copy is rejected — restore applies only to library masters.',
      inputSchema: SpecIdShape,
    },
    handleRestoreSpec
  );

  reg.register(
    'delete_spec',
    {
      description:
        'Withdraw a library-master spec — a soft, reversible removal (ADR-030, restore with ' +
        'restore_spec), not a hard delete. Idempotent. A project copy is rejected (unassign it ' +
        'from its project instead). Destructive: exposed only when the destructive tier is enabled.',
      inputSchema: SpecIdShape,
    },
    handleDeleteSpec
  );
}
