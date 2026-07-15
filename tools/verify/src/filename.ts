// Run-artifact filename sanitization for the visual round-trip verification
// harness (#150). This is defense-in-depth for the later file-serving route
// (GET /api/runs/:runId/files/:filename, serving rendered screenshots and
// pixel-diff output): even though the HTTP boundary schema constrains
// filenames to a known enum (FileNameParam, a later task), this guard exists
// so a bare filename can never be turned into a path-traversal primitive if
// that enum is ever loosened or bypassed.

import { basename } from 'node:path';
import { VerifyValidationError } from './errors.js';

// Bare filenames only: starts with an alphanumeric, then alphanumerics,
// '.', '_', or '-'. No path separators, no null bytes, no leading dot
// (which also rules out '.' and '..' outright), capped at 255 chars.
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Validate that `filename` is a safe, bare filename with no path-traversal
 * or path-separator content, and return it unchanged. Throws
 * VerifyValidationError (stage: 'report') on anything unsafe.
 */
export function sanitizeRunFilename(filename: string): string {
  const isSafe =
    SAFE_FILENAME_PATTERN.test(filename) &&
    !filename.includes('..') &&
    !filename.includes('\0') &&
    basename(filename) === filename;

  if (!isSafe) {
    throw new VerifyValidationError(`unsafe run filename: ${JSON.stringify(filename)}`, {
      stage: 'report',
    });
  }

  return filename;
}
