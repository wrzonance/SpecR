import type { MigrationBuilder } from 'node-pg-migrate';

// O-11 (ADR-022 D6) — onboarding_status records whether a human has reviewed the
// machine's first pass. Deliberately DISTINCT from lifecycle_state (migration 025,
// issuance posture). Default 'active' backfills existing rows; O-8 imports (#135)
// explicitly insert 'review'. Advisory only — no endpoint write-blocks on it.
const ONBOARDING_STATES = "('review','active')";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    onboarding_status: { type: 'text', notNull: true, default: 'active' },
  });
  pgm.addConstraint('specs', 'specs_onboarding_status_check', {
    check: `onboarding_status IN ${ONBOARDING_STATES}`,
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('specs', 'specs_onboarding_status_check');
  pgm.dropColumns('specs', ['onboarding_status']);
};
