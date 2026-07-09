import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as z from 'zod';
import { SpecrError } from './errors.js';
import type { GoldFingerprint } from './gold-fingerprint.js';

/** Repo-relative path of the committed blessed-fingerprint store. */
export const GOLD_STORE_PATH = 'gold/expectations.json';

export interface GoldEntry {
  readonly fingerprint: GoldFingerprint;
  readonly source: string | null;
  readonly blessedAt: string;
  // string | undefined (not just optional): a store read back from disk is
  // Zod-validated and z.string().optional() admits an explicit undefined.
  readonly note?: string | undefined;
}

/** Keyed by corpus-relative file path (POSIX). Section number is NOT the key —
 *  ARCAT and CPI both ship "09 91 26", which would collide. */
export type GoldStore = Record<string, GoldEntry>;

const ConfidenceBandsSchema = z.object({
  high: z.number(),
  review: z.number(),
  low: z.number(),
});
const GoldFingerprintSchema = z.object({
  section: z.string(),
  parts: z.number(),
  noteLeaks: z.number(),
  maxDepth: z.number(),
  partShape: z.array(z.array(z.number())),
  confidenceBands: ConfidenceBandsSchema,
});
const GoldEntrySchema = z.object({
  fingerprint: GoldFingerprintSchema,
  source: z.string().nullable(),
  blessedAt: z.string(),
  note: z.string().optional(),
});
const GoldStoreSchema: z.ZodType<GoldStore> = z.record(z.string(), GoldEntrySchema);

/** Read + validate the store. A missing file is an empty store (first-run safe);
 *  a corrupt/invalid one fails loud rather than silently gating on garbage. */
export async function readGoldStore(path: string = GOLD_STORE_PATH): Promise<GoldStore> {
  if (!existsSync(path)) return {};
  const parsed = GoldStoreSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) {
    throw new SpecrError(`invalid gold store: ${path}`, { cause: parsed.error });
  }
  return parsed.data;
}

/** Write the store with sorted keys, 2-space indent, and a trailing newline so a
 *  bless produces a minimal, reviewable git diff. */
export async function writeGoldStore(
  store: GoldStore,
  path: string = GOLD_STORE_PATH
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const sorted: GoldStore = {};
  for (const key of Object.keys(store).sort((a, b) => a.localeCompare(b))) {
    const value = store[key];
    if (value !== undefined) sorted[key] = value;
  }
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
