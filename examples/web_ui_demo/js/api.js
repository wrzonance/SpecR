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

// Deletes one cross-reference, leaving its paragraph in place.
export function deleteReference(specId, refId) {
  return sendJson('DELETE', `/specs/${enc(specId)}/references/${enc(refId)}`);
}

// Hard-deletes a spec (and everything it owns).
export function deleteSpec(specId) {
  return sendJson('DELETE', `/specs/${enc(specId)}`);
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

export function removeSpecFromProject(projectId, specId) {
  return sendJson('DELETE', `/projects/${enc(projectId)}/specs/${enc(specId)}`);
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

export function deleteProject(projectId, deletedBy) {
  return sendJson('DELETE', `/projects/${enc(projectId)}`, { deletedBy });
}

export function restoreProject(projectId) {
  return sendJson('POST', `/projects/${enc(projectId)}/restore`);
}

export function getRequiredSections(projectId) {
  return getJson(`/projects/${enc(projectId)}/required-sections`);
}

export function setRequiredSections(projectId, sections) {
  return sendJson('PUT', `/projects/${enc(projectId)}/required-sections`, { sections });
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
