import { createHash } from 'node:crypto';

/** SHA-256 hex digest of raw file bytes — ingest provenance identity (ADR-015 D2). */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
