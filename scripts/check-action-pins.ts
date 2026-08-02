/**
 * GitHub Actions floating-ref gate.
 *
 * `security.md` requires every third-party GitHub Action be pinned to a full
 * commit SHA, not a movable tag or branch — a moved tag executes in this repo
 * with whatever permissions/secrets the job grants it, no PR involved. Before
 * this check existed, `claude.yml` referenced `actions/checkout@v7` and
 * `anthropics/claude-code-action@v1` while a job in the same file granted
 * `id-token: write` plus an OAuth secret (#600).
 *
 * This asserts every `uses:` value across `.github/workflows/*.yml` is a
 * `<org>/<repo>@<40-char-hex-sha>` pin carrying a trailing `# vX.Y.Z` comment
 * (the convention already used in ci.yml/release.yml/codeql.yml, so a human
 * auditing the file can still tell what version is pinned).
 *
 * Run by `pnpm check:action-pins`, in CI and locally.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');

export class ActionPinError extends Error {}

/** One `uses:` ref, pinned and decoded. */
export interface PinnedActionRef {
  readonly repo: string;
  readonly sha: string;
  readonly versionComment: string;
}

const PINNED_REF = /^(?<repo>[^@\s]+)@(?<sha>[0-9a-f]{40})(?:\s+#\s*(?<comment>\S.*))?$/;

/**
 * A ref that has an `@` but is not a 40-char hex SHA is a floating tag or
 * branch (`v1`, `v7.0.1`, `main`) — the common, actionable case this gate
 * exists to catch. Anything else (malformed hex, missing repo) falls back to
 * a generic "not recognized" message.
 */
const describeUnpinnedRef = (trimmed: string, source: string): ActionPinError => {
  const afterAt = trimmed.slice(trimmed.indexOf('@') + 1).split(/\s/)[0];
  const isHexOnly = afterAt !== undefined && /^[0-9a-f]+$/.test(afterAt);
  // Hex but not 40 chars (e.g. an abbreviated SHA) is "not recognized", not a
  // floating ref — it's genuinely ambiguous whether it names a commit at all.
  if (afterAt !== undefined && afterAt.length > 0 && !isHexOnly) {
    return new ActionPinError(
      `${source}: "${trimmed}" is pinned to a floating tag or branch ("${afterAt}"), not a commit SHA`
    );
  }
  return new ActionPinError(
    `${source}: "${trimmed}" is not a recognized "<org>/<repo>@<40-hex-sha>" pin`
  );
};

/**
 * Validate a single `uses:` value, requiring a full commit SHA and a version
 * comment. Fails closed with a message naming the specific problem — mirrors
 * `check-node-pin.ts`'s `majorFromEngineRange` in shape.
 */
export const parsePinnedActionRef = (usesValue: string, source: string): PinnedActionRef => {
  const trimmed = usesValue.trim();

  if (!trimmed.includes('@')) {
    throw new ActionPinError(`${source}: "${trimmed}" has no @ref at all`);
  }

  const match = PINNED_REF.exec(trimmed);
  const repo = match?.groups?.['repo'];
  const sha = match?.groups?.['sha'];
  if (repo === undefined || sha === undefined) {
    throw describeUnpinnedRef(trimmed, source);
  }

  const comment = match?.groups?.['comment'];
  if (comment === undefined || comment.trim().length === 0) {
    throw new ActionPinError(
      `${source}: "${trimmed}" is pinned to a SHA but missing a trailing "# vX.Y.Z" version comment`
    );
  }

  return { repo, sha, versionComment: comment.trim() };
};

/** Pull the value of every `uses:` mapping key out of a workflow YAML source. */
export const extractUsesValues = (yaml: string): string[] => {
  const matches = yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(\S.*)$/gm);
  return Array.from(matches, (m) => m[1]?.trim()).filter((v): v is string => v !== undefined);
};

const workflowFiles = (): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(WORKFLOWS_DIR);
  } catch (err) {
    throw new ActionPinError(`could not read ${WORKFLOWS_DIR}`, { cause: err });
  }
  return entries.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
};

const checkFile = (filename: string): ActionPinError[] => {
  const path = join(WORKFLOWS_DIR, filename);
  const yaml = readFileSync(path, 'utf8');
  const errors: ActionPinError[] = [];
  for (const usesValue of extractUsesValues(yaml)) {
    try {
      parsePinnedActionRef(usesValue, filename);
    } catch (err) {
      if (!(err instanceof ActionPinError)) throw err;
      errors.push(err);
    }
  }
  return errors;
};

/**
 * Scan every workflow file under `.github/workflows/` for unpinned `uses:`
 * refs. Exported so `check-action-pins.test.ts` can assert this repo's real
 * files pass the same gate `pnpm check:action-pins` runs in CI (#600
 * regression), not just the parser's hardcoded-string unit cases.
 */
export const checkAllWorkflowRefs = (): ActionPinError[] => workflowFiles().flatMap(checkFile);

const main = (): void => {
  let errors: ActionPinError[];
  try {
    errors = checkAllWorkflowRefs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ Action pin check failed: ${message}`);
    process.exit(1);
    return;
  }

  if (errors.length > 0) {
    console.error(`✗ Found ${errors.length} unpinned GitHub Action reference(s):`);
    for (const err of errors) console.error(`    ${err.message}`);
    process.exit(1);
    return;
  }

  console.log('✓ Every GitHub Action reference is pinned to a commit SHA with a version comment.');
};

// Only run when invoked directly (`pnpm check:action-pins`), so the parser
// above can be imported by its test without the process exiting.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
