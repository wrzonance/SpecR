// Conflict classifier for removing a project-owned section copy (#413).
//
// DELETE /projects/:id/specs/:specId returns 409 for two distinct reasons and
// the demo's affordance differs: an EDITED copy may be force-deleted (the
// admin path, ?force=true), a PACKAGE-PINNED copy may not. The server signals
// which via the error message; anything unrecognized stays an ordinary
// failure so the demo never force-retries blindly. Pure, no DOM.

/** @returns {'force-retry' | 'in-package' | 'other'} */
export function classifyRemovalConflict(err) {
  if (!err || err.status !== 409) return 'other';
  const message = String(err.message ?? '');
  if (message.includes('force=true')) return 'force-retry';
  if (message.includes('package')) return 'in-package';
  return 'other';
}
