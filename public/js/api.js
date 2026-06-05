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

export function checkHealth() {
  return getJson('/health');
}

export function listSpecs() {
  return getJson('/specs');
}

export function getSpecTree(specId) {
  return getJson(`/specs/${encodeURIComponent(specId)}/tree`);
}

// Uploads one file to POST /parse. Resolves with { jobId }.
// Throws { rateLimited: true } on 429 so callers can back off and retry.
export async function uploadSpec(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/parse', { method: 'POST', body: form });
  if (res.status === 429) {
    const err = new Error('rate limited');
    err.rateLimited = true;
    throw err;
  }
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(body.error || `upload failed: ${res.status}`);
  }
  return body.data;
}

export function getParseJob(jobId) {
  return getJson(`/parse/jobs/${encodeURIComponent(jobId)}`);
}

// Polls a parse job until it completes or fails. Calls onProgress with the
// job object on every poll tick. Resolves with the completed job's result.
export async function waitForParseJob(jobId, onProgress, pollMs = 400) {
  for (;;) {
    const job = await getParseJob(jobId);
    if (onProgress) onProgress(job);
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') {
      throw new Error(job.error || 'parse failed');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
