// REST client for the SpecR API. All endpoints return the ApiResponse
// envelope: { success: boolean, data?, error? }.

async function getJson(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return body.data;
}

// JSON request for mutations (POST/PATCH/DELETE). Resolves with `data`. Throws
// an Error carrying `.status` so callers can branch on 404/409 etc.
async function sendJson(method, path, payload) {
  const opts = { method, headers: {} };
  if (payload !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(payload);
  }
  const res = await fetch(path, opts);
  // 204 No Content (association/profile deletes, clear-assignment) carries no
  // body — a bare 2xx is success. Reading res.json() on it would throw.
  if (res.status === 204) return undefined;
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.success !== true) {
    const err = new Error((body && body.error) || `request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body.data;
}

const enc = encodeURIComponent;

export function checkHealth() {
  return getJson('/health');
}

export function listSpecs() {
  return getJson('/specs');
}

// GET /specs/:id returns the tree fields spread (+ styleSource); adapt to the
// { tree, references } shape the board state expects. Per-spec references are
// project-scoped (ADR-024) and fetched separately via getOutboundReferences.
export async function getSpecTree(specId) {
  const tree = await getJson(`/specs/${encodeURIComponent(specId)}`);
  return { tree, references: [] };
}

// Per-paragraph hierarchy-inference scoring report (WS2, #424): every scored
// structural paragraph, worst confidence first, plus counts and (when any
// paragraph carries no inference provenance) an unscoredReason explaining why.
export function getHierarchyReport(specId) {
  return getJson(`/specs/${encodeURIComponent(specId)}/hierarchy-report`);
}

export function listLibraries() {
  return getJson('/libraries');
}

export function createClientLibrary(name) {
  return sendJson('POST', '/libraries/clients', { name });
}

export function renameLibrary(libraryId, name) {
  return sendJson('PATCH', `/libraries/${enc(libraryId)}`, { name });
}

export function listLibrarySpecs(libraryId) {
  return getJson(`/libraries/${enc(libraryId)}/specs`);
}

// Onboards a spec INTO a library via POST /libraries/:id/import (async, 202).
// This is the correct path for "Add Specs to a library": unlike POST /parse
// (which creates a standalone spec with no library), the import handler persists
// the spec against the target library, so it appears in listLibrarySpecs. The
// returned { jobId } is polled with waitForImportJob. 404 if the library is
// unknown; 429 shares the /parse rate limit.
export async function importSpecToLibrary(file, libraryId) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`/libraries/${enc(libraryId)}/import`, { method: 'POST', body: form });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.success !== true) {
    const err = new Error((body && body.error) || `library import failed: ${res.status}`);
    err.status = res.status;
    err.responseBody = body;
    console.error(`SpecR library import rejected (HTTP ${res.status}) for ${file.name}:`, body);
    throw err;
  }
  return body.data; // { jobId }
}

export function getImportJob(jobId) {
  return getJson(`/libraries/import/jobs/${enc(jobId)}`);
}

// Polls a library-onboarding job to completion. Same onProgress contract as
// waitForParseJob; the resolved result is the OnboardingJobResult
// ({ specId, section, title, libraryId, report }) — note: no nodeCount.
export async function waitForImportJob(jobId, onProgress, pollMs = 400) {
  for (;;) {
    const job = await getImportJob(jobId);
    if (onProgress) onProgress(job);
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') {
      console.error(`SpecR import job ${jobId} failed:`, job);
      const err = new Error(job.error || 'import failed');
      err.jobId = jobId;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Uploads one file to POST /parse. Resolves with { jobId }.
export async function uploadSpec(file, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, value);
  }
  form.append('file', file, file.name);
  const res = await fetch('/parse', { method: 'POST', body: form });
  const body = await res.json();
  if (!res.ok || !body.success) {
    const err = new Error(body.error || `upload failed: ${res.status}`);
    err.status = res.status;
    err.responseBody = body;
    // Full server response in the console — proprietary files can't be shared,
    // so the failure must be diagnosable from local output alone.
    console.error(`SpecR upload rejected (HTTP ${res.status}) for ${file.name}:`, body);
    throw err;
  }
  return body.data;
}

export function getParseJob(jobId) {
  return getJson(`/parse/jobs/${encodeURIComponent(jobId)}`);
}

// ── Demo edit mutations ──────────────────────────────────────────────────

// Deletes a paragraph; the server cascade also removes any reference it held
// and any descendant paragraphs.
export function deleteParagraph(specId, paragraphId) {
  return sendJson('DELETE', `/specs/${enc(specId)}/paragraphs/${enc(paragraphId)}`);
}

// Replaces a paragraph's body text.
export function updateParagraph(specId, paragraphId, text) {
  return sendJson('PATCH', `/specs/${enc(specId)}/paragraphs/${enc(paragraphId)}`, { text });
}

// Creates a paragraph immediately after `anchorNodeId`, as its sibling (#372).
// nodeType defaults server-side to the anchor's own type; only article,
// pr1..pr7, and continuation are insertable. Resolves with the created
// SpecNode; 404 unknown anchor, 403 wrong spec, 422 uninsertable type.
export function insertParagraph(specId, anchorNodeId, text, nodeType) {
  const body = { anchorNodeId, text };
  if (nodeType) body.nodeType = nodeType;
  return sendJson('POST', `/specs/${enc(specId)}/paragraphs`, body);
}

// Soft, reversible paragraph removal (#251). `removed: true` sets the node's
// vanish flag (suppressed from owner-facing renders); `false` restores it. The
// subtree and any contained references stay intact. Only body paragraphs
// (pr1–pr7 / continuation) are removable — a part/article/note rejects 422.
// Resolves with the updated SpecNode subtree.
export function setParagraphRemoved(specId, nodeId, removed) {
  return sendJson('PATCH', `/specs/${enc(specId)}/paragraphs/${enc(nodeId)}/removal`, { removed });
}

// Deletes one cross-reference, leaving its paragraph in place.
export function deleteReference(specId, refId) {
  return sendJson('DELETE', `/specs/${enc(specId)}/references/${enc(refId)}`);
}

// Soft-withdraws a library master (ADR-030): tombstones it with withdrawnAt,
// hiding it from listings and project source resolution while keeping the row
// and clone lineage intact. Reversible via restoreSpec. 409 on a project copy
// (those are removed via removeSpecFromProject).
export function withdrawSpec(specId) {
  return sendJson('DELETE', `/specs/${enc(specId)}`);
}

// Clears a master's withdrawal tombstone — it reappears in listings and
// resolution. Idempotent.
export function restoreSpec(specId) {
  return sendJson('POST', `/specs/${enc(specId)}/restore`);
}

// ── Project membership (backs the demo board's broken-ref cascade) ─────────

export function createProject(name, description, sourceLibraryIds) {
  const body = { name };
  if (description) body.description = description;
  if (sourceLibraryIds) body.sourceLibraryIds = sourceLibraryIds;
  return sendJson('POST', '/projects', body);
}

export function listProjects() {
  return getJson('/projects');
}

export function getProject(projectId) {
  return getJson(`/projects/${enc(projectId)}`);
}

export function patchProject(projectId, patch) {
  return sendJson('PATCH', `/projects/${enc(projectId)}`, patch);
}

export function setProjectSources(projectId, sourceLibraryIds) {
  return sendJson('PUT', `/projects/${enc(projectId)}/sources`, { sourceLibraryIds });
}

export function addSpecToProject(projectId, section) {
  return sendJson('POST', `/projects/${enc(projectId)}/specs`, { section });
}

// Removes a project-owned section copy. An edited copy (content_version > 1)
// answers 409 unless force — the admin path that discards its project edits.
export function removeSpecFromProject(projectId, specId, { force = false } = {}) {
  const query = force ? '?force=true' : '';
  return sendJson('DELETE', `/projects/${enc(projectId)}/specs/${enc(specId)}${query}`);
}

export function getBrokenRefs(projectId) {
  return getJson(`/projects/${enc(projectId)}/references/broken`);
}

// Outbound cross-references for one project spec (project-scoped, ADR-024).
// Returns the references array already in the web model's shape
// ({ targetSection, targetSpecId, isBroken, ... }).
export async function getOutboundReferences(projectId, specId) {
  const data = await getJson(`/projects/${enc(projectId)}/specs/${enc(specId)}/references`);
  return data.references;
}

export function getCoordinationReport(projectId, packageId) {
  const qs = packageId ? `?packageId=${enc(packageId)}` : '';
  return getJson(`/projects/${enc(projectId)}/coordination-report${qs}`);
}

export function getSubmittalRegister(projectId, specIds) {
  return sendJson('POST', `/projects/${enc(projectId)}/submittal-register`, { specIds });
}

// Grounded cross-spec comparison (ADR-047). `sources` is exactly two live spec
// UUIDs; optional `baseline` must be one of them. Resolves with the
// ComparisonReport { columns, rows, baseline?, drift? }. 404 if a source id is
// not a live spec; 422 on a malformed request.
export function postCompareReport(sources, { baseline, include } = {}) {
  const body = { sources };
  if (baseline) body.baseline = baseline;
  // The demo deliberately fetches the FULL matrix (default include='all', so we
  // omit it): the 'Changes only' context expander reveals collapsed identical
  // rows in place, which requires them present client-side. `include` is plumbed
  // for parity with the #384 option but not sent by default (ADR-053 synergy —
  // `summary` still reports full-matrix totals regardless of this filter).
  if (include) body.include = include;
  return sendJson('POST', '/reports/compare', body);
}

export function deleteProject(projectId, deletedBy) {
  return sendJson('DELETE', `/projects/${enc(projectId)}`, { deletedBy });
}

export function restoreProject(projectId) {
  return sendJson('POST', `/projects/${enc(projectId)}/restore`);
}

// Unresolved review comments for one spec (#262). Resolves with the
// OpenCommentsReport: { scope, openComments: [{ specSection, author, text, … }],
// summary: { open, total } }.
export function getOpenComments(specId) {
  return getJson(`/specs/${enc(specId)}/open-comments`);
}

// Unresolved review comments across every spec in a project (#272). Same
// OpenCommentsReport shape, scoped to the project.
export function getProjectOpenComments(projectId) {
  return getJson(`/projects/${enc(projectId)}/open-comments`);
}

export function getRequiredSections(projectId) {
  return getJson(`/projects/${enc(projectId)}/required-sections`);
}

export function setRequiredSections(projectId, sections) {
  return sendJson('PUT', `/projects/${enc(projectId)}/required-sections`, { sections });
}

// ── Numbering profiles (#299 / #317 / #320) ───────────────────────────────
// A numbering profile is the source DOCX's structural numbering scheme (part
// tier bounds, articleIlvl, numId→level map, style→tier ladder) captured as an
// editable, library-scoped profile. NULL library = the built-in "CSI Default"
// singleton, which every unassigned spec resolves to (byte-for-byte today's
// engine behavior). Rows carry { id, libraryId, name, rules, createdAt, updatedAt }.

// Lists a library's numbering profiles — always includes the built-in CSI
// Default (libraryId: null). 404 if the library id is unknown (#320).
export function listNumberingProfiles(libraryId) {
  return getJson(`/libraries/${enc(libraryId)}/numbering-profiles`);
}

// Creates a library-scoped profile from a full NumberingProfile `rules` object.
// 201 → the persisted row; 404 unknown library; 422 invalid rules.
export function createNumberingProfile(libraryId, name, rules) {
  return sendJson('POST', `/libraries/${enc(libraryId)}/numbering-profiles`, { name, rules });
}

export function getNumberingProfile(profileId) {
  return getJson(`/numbering-profiles/${enc(profileId)}`);
}

// Renames / re-rules a profile. 409 if it targets the immutable built-in.
export function updateNumberingProfile(profileId, patch) {
  return sendJson('PATCH', `/numbering-profiles/${enc(profileId)}`, patch);
}

// Deletes a profile. 409 if built-in or still assigned to one or more specs.
export function deleteNumberingProfile(profileId) {
  return sendJson('DELETE', `/numbering-profiles/${enc(profileId)}`);
}

// Uploads a .docx to POST /numbering-profiles/snapshot and resolves with the
// extracted NumberingProfile (tiers, numbering, styleLadder, articleIlvl) —
// nothing is persisted. 400 non-docx / unsafe; 422 extraction failure.
export async function snapshotNumberingProfile(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/numbering-profiles/snapshot', { method: 'POST', body: form });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.success !== true) {
    const err = new Error((body && body.error) || `snapshot failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body.data;
}

// Assigns a numbering profile to a spec. 200 → { profileId, name }; 404 spec or
// profile not found; 409 if the profile belongs to a different library (#320).
export function setSpecNumberingProfile(specId, profileId) {
  return sendJson('PUT', `/specs/${enc(specId)}/numbering-profile`, { profileId });
}

export function clearSpecNumberingProfile(specId) {
  return sendJson('DELETE', `/specs/${enc(specId)}/numbering-profile`);
}

// Polls a parse job until it completes or fails. Calls onProgress with the
// job object on every poll tick. Resolves with the completed job's result.
export async function waitForParseJob(jobId, onProgress, pollMs = 400) {
  for (;;) {
    const job = await getParseJob(jobId);
    if (onProgress) onProgress(job);
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') {
      console.error(`SpecR parse job ${jobId} failed:`, job);
      const err = new Error(job.error || 'parse failed');
      err.jobId = jobId;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
