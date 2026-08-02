/**
 * `claude.yml` job-permissions drift gate.
 *
 * #600 found the `claude` job granted `id-token: write` (plus a
 * `CLAUDE_CODE_OAUTH_TOKEN` secret) to steps referencing GitHub Actions by a
 * floating major tag — a moved tag would have executed with that grant, no PR
 * involved. The actions are now SHA-pinned (`check-action-pins.ts`).
 *
 * `id-token: write` itself was deliberately KEPT rather than removed:
 * `anthropics/claude-code-action`'s internals aren't vendored into this repo,
 * so there is no local evidence it doesn't perform an OIDC exchange, and an
 * uncertain removal risks a silent auth break. That decision needs to survive
 * future edits without silently drifting — so this pins the exact permission
 * set the `claude` job is reviewed to hold. A PR that changes it must update
 * this test *and* document why in its own body, rather than the grant
 * widening or narrowing unnoticed.
 *
 * Run by `scripts/check-workflow-permissions.test.ts`; not a standalone CLI
 * (unlike `check-action-pins.ts`/`check-node-pin.ts`) because there is only
 * one workflow file with a `permissions:` block worth pinning this tightly.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CLAUDE_WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'claude.yml');

export class WorkflowPermissionsError extends Error {}

const JOB_INDENT = '  ';
const BLOCK_HEADER_INDENT = '    ';
const ENTRY_INDENT = '      ';

/**
 * Slice out just the named job's own body — from right after its header up
 * to (but not including) the next sibling job header (a line back at
 * `JOB_INDENT` followed by non-whitespace), or end of file if it's the last
 * job. Without this bound, a search for `permissions:` run against the rest
 * of the whole file can walk past this job's body and match a LATER job's
 * block instead.
 */
const sliceJobBody = (afterJobHeader: string): string => {
  const nextJobHeader = new RegExp(`^${JOB_INDENT}\\S`, 'm');
  const nextMatch = nextJobHeader.exec(afterJobHeader);
  return nextMatch === null ? afterJobHeader : afterJobHeader.slice(0, nextMatch.index);
};

/**
 * Extract the flat `key: value` grants under a named job's `permissions:`
 * block. Assumes the two-space-per-nesting-level indentation this repo's
 * workflow files use throughout (`jobs:` > `<job>:` > `permissions:` >
 * entries), matching the literal layout of `.github/workflows/claude.yml`.
 */
export const extractJobPermissions = (yaml: string, jobName: string): Record<string, string> => {
  const jobHeader = new RegExp(`^${JOB_INDENT}${jobName}:\\s*$`, 'm');
  const jobMatch = jobHeader.exec(yaml);
  if (jobMatch === null) {
    throw new WorkflowPermissionsError(`no "${jobName}:" job found`);
  }

  const jobBody = sliceJobBody(yaml.slice(jobMatch.index + jobMatch[0].length));
  const permsHeader = new RegExp(`^${BLOCK_HEADER_INDENT}permissions:\\s*$`, 'm');
  const permsMatch = permsHeader.exec(jobBody);
  if (permsMatch === null) {
    throw new WorkflowPermissionsError(`job "${jobName}" has no "permissions:" block`);
  }

  return parsePermissionEntries(jobBody.slice(permsMatch.index + permsMatch[0].length));
};

/** Read `key: value` lines until the block dedents (a shallower indent ends it). */
const parsePermissionEntries = (afterPermsHeader: string): Record<string, string> => {
  const entryPattern = new RegExp(`^${ENTRY_INDENT}([a-z-]+):\\s*(\\S+)`);
  const permissions: Record<string, string> = {};
  for (const line of afterPermsHeader.split('\n')) {
    // The header's own line-end leaves a blank first element (and blank
    // lines may separate entries) — neither dedents the block, so skip them
    // rather than treating them as the end of the permissions list.
    if (line.trim().length === 0) continue;
    const entry = entryPattern.exec(line);
    if (entry === null) break;
    const [, key, value] = entry;
    if (key !== undefined && value !== undefined) permissions[key] = value;
  }
  return permissions;
};

/** The `claude` job's reviewed permission set, read live from `claude.yml`. */
export const claudeJobPermissions = (): Record<string, string> => {
  let yaml: string;
  try {
    yaml = readFileSync(CLAUDE_WORKFLOW_PATH, 'utf8');
  } catch (err) {
    throw new WorkflowPermissionsError(`could not read ${CLAUDE_WORKFLOW_PATH}`, { cause: err });
  }
  return extractJobPermissions(yaml, 'claude');
};
