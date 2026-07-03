import {
  handleGetSpecLock,
  handleLockSpec,
  handleUnlockSpec,
  SpecLockIdShape,
  LockSpecShape,
  UnlockSpecShape,
} from './lock-handlers.js';
import {
  handleAssignStyleSource,
  handleClearStyleSource,
  handleAssignNumberingProfile,
  handleClearNumberingProfile,
  AssignmentSpecIdShape,
  AssignStyleSourceShape,
  AssignNumberingProfileShape,
} from './assignment-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerSpecAssignmentTools(reg: ToolRegistrar): void {
  registerLockTools(reg);
  registerStyleSourceTools(reg);
  registerNumberingProfileTools(reg);
}

function registerLockTools(reg: ToolRegistrar): void {
  reg.register(
    'get_spec_lock',
    {
      description:
        'Read the current advisory lock on a spec (ADR-018 D2) — a visibility hint, not a ' +
        'write block. Returns { locked, lock }; an expired lock reads as free.',
      inputSchema: SpecLockIdShape,
    },
    handleGetSpecLock
  );

  reg.register(
    'lock_spec',
    {
      description:
        'Acquire (or refresh) the advisory soft-lock on a spec — a "someone is editing this" ' +
        'hint (ADR-018 D2), never a write block. Provide holder (your identity) and optional ' +
        'ttlSeconds (1–3600). Rejected if a live lock is held by another holder.',
      inputSchema: LockSpecShape,
    },
    handleLockSpec
  );

  reg.register(
    'unlock_spec',
    {
      description:
        'Release the advisory lock on a spec. Provide the same holder used to acquire it; ' +
        'rejected if no lock is held by that holder.',
      inputSchema: UnlockSpecShape,
    },
    handleUnlockSpec
  );
}

function registerStyleSourceTools(reg: ToolRegistrar): void {
  reg.register(
    'assign_style_source',
    {
      description:
        'Assign a style template to a spec so the generator renders it with a real house style ' +
        '(#138). One template per spec; re-assigning replaces the previous. Returns ' +
        '{ templateId, templateName }.',
      inputSchema: AssignStyleSourceShape,
    },
    handleAssignStyleSource
  );

  reg.register(
    'clear_style_source',
    {
      description:
        'Clear a spec’s assigned style template (idempotent — clearing an unassigned spec still ' +
        'succeeds). Returns { styleSource: null }.',
      inputSchema: AssignmentSpecIdShape,
    },
    handleClearStyleSource
  );
}

function registerNumberingProfileTools(reg: ToolRegistrar): void {
  reg.register(
    'assign_numbering_profile',
    {
      description:
        'Assign a structural numbering profile to a spec. The profile must belong to the same ' +
        'library as the spec (else rejected). Returns { profileId, name }. An unassigned spec ' +
        'resolves to the built-in CSI Default profile (see get_numbering_profile).',
      inputSchema: AssignNumberingProfileShape,
    },
    handleAssignNumberingProfile
  );

  reg.register(
    'clear_numbering_profile',
    {
      description:
        'Clear a spec’s assigned numbering profile so it falls back to the built-in CSI Default. ' +
        'Returns { cleared: true }.',
      inputSchema: AssignmentSpecIdShape,
    },
    handleClearNumberingProfile
  );
}
