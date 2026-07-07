// Pure model for a project's ordered source-library chain (#413).
//
// The server contract (PUT /projects/:id/sources) treats array order as
// resolution priority: when a section is added to a project, the FIRST source
// library holding it wins and the rest are reported back as `shadowed`.
// Everything here is pure so the ordering rules stay testable without a DOM.

/**
 * Merge a client-scope change into an existing ordered source chain without
 * reprioritizing it. Clients no longer in scope drop out; newly scoped
 * clients APPEND (they never outrank existing sources); the company master
 * is kept — appended at the end when absent. Returns ordered library ids.
 */
export function mergeSourcesWithScope(currentSources, scopedClientIds, companyId) {
  const scoped = new Set(scopedClientIds);
  const kept = currentSources
    .filter((source) => source.tier !== 'client' || scoped.has(source.libraryId))
    .map((source) => source.libraryId);
  const present = new Set(kept);
  const appended = scopedClientIds.filter((id) => !present.has(id));
  const ids = [...kept, ...appended];
  if (companyId && !ids.includes(companyId)) ids.push(companyId);
  return ids;
}

/** Move `id` by `delta` positions (new array; no-op at edges or unknown id). */
export function moveSource(ids, id, delta) {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next[from] = next[to];
  next[to] = id;
  return next;
}

/**
 * Human-readable outcome of an addSectionToProject resolution.
 * Returns { kind, message } for a toast, or null when there is nothing
 * noteworthy (clean, unshadowed resolution from the expected library).
 */
export function resolutionNotice(result, expectedLibraryId) {
  const source = result?.source;
  if (!source) return null;
  if (expectedLibraryId && source.libraryId !== expectedLibraryId) {
    return {
      kind: 'warn',
      message:
        `Section resolved from "${source.name}", which shadows the library you targeted — ` +
        'reorder SOURCE LIBRARIES in Project Settings to change which master wins.',
    };
  }
  const shadowed = result.shadowed ?? [];
  if (shadowed.length > 0) {
    const names = shadowed.map((library) => library.name).join(', ');
    return {
      kind: 'info',
      message: `Loaded from ${source.name} — also held by lower-priority: ${names}`,
    };
  }
  return null;
}
