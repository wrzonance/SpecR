// scripts/gold.ts
import { readFile, glob } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '../src/parser/index.js';
import { computeFingerprint } from '../src/lib/gold-fingerprint.js';
import { readGoldStore, writeGoldStore, GOLD_STORE_PATH } from '../src/lib/gold-store.js';
import { verifyCorpus, blessEntries, type CorpusResult } from '../src/lib/gold-verify.js';

const PROJECT_ROOT = process.cwd();
const REF_DIR = 'docs/references';
const CORPUS_GLOB = `${REF_DIR}/**/*.{docx,sec,SEC}`;

function sourceOf(rel: string): string | null {
  const [first, ...rest] = relative(REF_DIR, rel).split(/[/\\]/);
  return rest.length > 0 && first ? first : null;
}

async function fingerprintCorpus(pattern: string): Promise<CorpusResult[]> {
  const results: CorpusResult[] = [];
  for await (const rel of glob(pattern, { cwd: PROJECT_ROOT })) {
    const abs = join(PROJECT_ROOT, rel);
    // Store keys are documented as POSIX-normalized; glob's `rel` is already forward-slash
    // on POSIX platforms, but normalize explicitly so the committed store stays portable
    // (and verify/bless key identically) if this ever runs on Windows.
    const key = rel.replaceAll('\\', '/');
    try {
      const { tree, refs } = await parse(await readFile(abs), abs);
      results.push({ path: key, ok: true, fingerprint: computeFingerprint(tree, refs) });
    } catch (err) {
      results.push({
        path: key,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function verify(): Promise<number> {
  if (!existsSync(REF_DIR)) {
    console.log(`${REF_DIR} not present — gold:verify is a no-op (corpus is local-only).`);
    return 0;
  }
  const results = await fingerprintCorpus(CORPUS_GLOB);
  const { failures, gated, ungated, missingLocally } = verifyCorpus(results, await readGoldStore());
  for (const f of failures) {
    console.log(`\n✗ ${f.path}`);
    for (const d of f.deltas)
      console.log(`    ${d.field}: blessed ${d.expected} → got ${d.actual}`);
  }
  for (const path of missingLocally) console.log(`\n? ${path} (blessed but absent locally)`);
  console.log(
    `\n${gated} gated, ${ungated} ungated, ${missingLocally.length} missing-locally, ${failures.length} FAILED`
  );
  return failures.length > 0 ? 1 : 0;
}

async function bless(patternArg?: string): Promise<number> {
  if (!existsSync(REF_DIR)) {
    console.log(`${REF_DIR} not present — nothing to bless.`);
    return 0;
  }
  const results = await fingerprintCorpus(patternArg ?? CORPUS_GLOB);
  const { store, blessed, skipped } = blessEntries(await readGoldStore(), results, {
    blessedAt: new Date().toISOString(),
    sourceOf,
  });
  await writeGoldStore(store);
  for (const p of blessed) console.log(`✓ blessed ${p}`);
  for (const s of skipped) console.log(`⤫ skipped ${s.path} (${s.error})`);
  console.log(`\nblessed ${blessed.length}, skipped ${skipped.length} → ${GOLD_STORE_PATH}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'verify') return verify();
  if (cmd === 'bless') return bless(rest[0]);
  console.error('Usage: gold verify | gold bless [glob]');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
