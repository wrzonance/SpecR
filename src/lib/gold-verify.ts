// src/lib/gold-verify.ts
import { diffFingerprint } from './gold-fingerprint.js';
import type { FingerprintDelta, GoldFingerprint } from './gold-fingerprint.js';
import type { GoldStore } from './gold-store.js';

/** One corpus file's parse outcome: a fingerprint, or a parse error. */
export type CorpusResult =
  | { readonly path: string; readonly ok: true; readonly fingerprint: GoldFingerprint }
  | { readonly path: string; readonly ok: false; readonly error: string };

export interface VerifyFailure {
  readonly path: string;
  readonly deltas: readonly FingerprintDelta[];
}

export interface VerifyResult {
  readonly failures: readonly VerifyFailure[];
  readonly gated: number;
  readonly ungated: number;
  readonly missingLocally: readonly string[];
}

function parseErrorDelta(error: string): FingerprintDelta {
  return { field: 'parse', expected: 'parseable (blessed)', actual: `parse-error: ${error}` };
}

/** Compare each parsed corpus file to its blessed entry. Only blessed paths gate;
 *  un-blessed files are counted (`ungated`), blessed-but-absent files are reported
 *  (`missingLocally`), and any deviation from a blessed entry is a `failure`. */
export function verifyCorpus(results: readonly CorpusResult[], store: GoldStore): VerifyResult {
  const failures: VerifyFailure[] = [];
  let gated = 0;
  let ungated = 0;
  const seen = new Set<string>();
  for (const result of results) {
    seen.add(result.path);
    const entry = store[result.path];
    if (entry === undefined) {
      ungated += 1;
      continue;
    }
    gated += 1;
    const deltas = result.ok
      ? diffFingerprint(entry.fingerprint, result.fingerprint)
      : [parseErrorDelta(result.error)];
    if (deltas.length > 0) failures.push({ path: result.path, deltas });
  }
  const missingLocally = Object.keys(store)
    .filter((path) => !seen.has(path))
    .sort((a, b) => a.localeCompare(b));
  return { failures, gated, ungated, missingLocally };
}

export interface BlessMeta {
  readonly blessedAt: string;
  readonly sourceOf: (path: string) => string | null;
}

export interface BlessResult {
  readonly store: GoldStore;
  readonly blessed: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly error: string }[];
}

/** Pure upsert of blessed fingerprints into a NEW store (input untouched). An
 *  existing entry's `note` is preserved; unparseable files are skipped. */
export function blessEntries(
  store: GoldStore,
  results: readonly CorpusResult[],
  meta: BlessMeta
): BlessResult {
  const next: GoldStore = { ...store };
  const blessed: string[] = [];
  const skipped: { path: string; error: string }[] = [];
  for (const result of results) {
    if (!result.ok) {
      skipped.push({ path: result.path, error: result.error });
      continue;
    }
    const existingNote = next[result.path]?.note;
    next[result.path] = {
      fingerprint: result.fingerprint,
      source: meta.sourceOf(result.path),
      blessedAt: meta.blessedAt,
      ...(existingNote !== undefined ? { note: existingNote } : {}),
    };
    blessed.push(result.path);
  }
  return { store: next, blessed, skipped };
}
