import { describe, it, expect } from 'vitest';
import { checkParentRevisionRules, RevisionParentValidationError } from './revision-parent.js';
import type { ParentRevisionCandidate } from './revision-parent.js';

const targetPackageId = 'pkg-1';
const parentRevisionId = 'rev-parent-1';

function candidate(overrides: Partial<ParentRevisionCandidate> = {}): ParentRevisionCandidate {
  return { packageId: targetPackageId, parentRevisionId: null, ...overrides };
}

describe('checkParentRevisionRules', () => {
  it('no-ops when parentRevisionId is null (no parent requested)', () => {
    expect(() => checkParentRevisionRules(targetPackageId, null, null)).not.toThrow();
  });

  it('does not throw for a same-package, root (depth-0) candidate', () => {
    expect(() =>
      checkParentRevisionRules(targetPackageId, parentRevisionId, candidate())
    ).not.toThrow();
  });

  it('throws when the candidate does not exist (not found)', () => {
    expect(() => checkParentRevisionRules(targetPackageId, parentRevisionId, null)).toThrow(
      RevisionParentValidationError
    );
  });

  it('throws when the candidate belongs to a different package (cross-package)', () => {
    expect(() =>
      checkParentRevisionRules(targetPackageId, parentRevisionId, candidate({ packageId: 'pkg-2' }))
    ).toThrow(RevisionParentValidationError);
  });

  it('does not throw for a same-package candidate when packageId casing differs (Postgres canonicalizes uuid columns to lowercase, but the route-param packageId is passed through as typed)', () => {
    const mixedCaseId = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    expect(() =>
      checkParentRevisionRules(
        mixedCaseId,
        parentRevisionId,
        candidate({ packageId: mixedCaseId.toLowerCase() })
      )
    ).not.toThrow();
  });

  it('throws when the candidate already has a parent (nesting depth > 1)', () => {
    expect(() =>
      checkParentRevisionRules(
        targetPackageId,
        parentRevisionId,
        candidate({ parentRevisionId: 'rev-grandparent' })
      )
    ).toThrow(RevisionParentValidationError);
  });
});
