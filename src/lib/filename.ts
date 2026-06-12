import path from 'node:path';

/**
 * Leaf filename from an untrusted, caller-supplied string (multer originalname,
 * MCP tool params) — ingest provenance must never store path fragments (ADR-015 D2).
 *
 * `path.win32.basename` treats both `/` and `\` as separators, so POSIX paths
 * (`/tmp/spec.sec`) and Windows fragments (`C:\fakepath\spec.sec`) both reduce
 * to `spec.sec`. Trusted local paths (lib/file-loader.ts) keep platform-native
 * `path.basename` instead — a POSIX filename may legitimately contain `\`.
 */
export function sanitizeFilename(input: string): string {
  return path.win32.basename(input);
}
