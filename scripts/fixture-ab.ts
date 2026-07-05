// scripts/fixture-ab.ts
import { existsSync } from 'node:fs';
import { snapshotCorpus, writeSnapshot, readSnapshot, diffSnapshots } from '../src/lib/fixture-snapshot.js';

const OUT_DIR = '.fixture-snapshots';

async function snapshot(label: string): Promise<number> {
  if (!existsSync('docs/references')) {
    console.log('docs/references not present — nothing to snapshot.');
    return 0;
  }
  const snap = await snapshotCorpus();
  const path = await writeSnapshot(snap, OUT_DIR, label);
  const errors = Object.values(snap).filter((r) => r.error).length;
  console.log(`snapshotted ${Object.keys(snap).length} fixtures (${errors} parse-error) → ${path}`);
  return 0;
}

async function diff(a: string, b: string): Promise<number> {
  const before = await readSnapshot(`${OUT_DIR}/${a}.json`);
  const after = await readSnapshot(`${OUT_DIR}/${b}.json`);
  const { changed, total } = diffSnapshots(before, after);
  for (const c of changed) {
    if (c.presence) { console.log(`\n=== ${c.path}  (${c.presence}) ===`); continue; }
    const bits = [
      c.parts ? `parts ${c.parts[0]}→${c.parts[1]}` : '',
      c.noteLeaks ? `noteLeaks ${c.noteLeaks[0]}→${c.noteLeaks[1]}` : '',
      c.error ? `error ${c.error[0] ?? 'none'}→${c.error[1] ?? 'none'}` : '',
    ].filter(Boolean).join(' ');
    console.log(`\n=== ${c.path} ${bits} ===`);
    c.refsRemoved.forEach((r) => console.log(`  - ref ${r}`));
    c.refsAdded.forEach((r) => console.log(`  + ref ${r}`));
    c.linesRemoved.slice(0, 8).forEach((l) => console.log(`  - ${l.slice(0, 100)}`));
    c.linesAdded.slice(0, 8).forEach((l) => console.log(`  + ${l.slice(0, 100)}`));
    const noDetail =
      !bits &&
      !c.refsRemoved.length &&
      !c.refsAdded.length &&
      !c.linesRemoved.length &&
      !c.linesAdded.length;
    if (noDetail) console.log('  (render changed with no net line add/remove — reordered or whitespace-only)');
  }
  console.log(`\n${changed.length}/${total} fixtures changed`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'snapshot' && rest[0]) return snapshot(rest[0]);
  if (cmd === 'diff' && rest[0] && rest[1]) return diff(rest[0], rest[1]);
  console.error('Usage: fixture-ab snapshot <label> | fixture-ab diff <before> <after>');
  return 1;
}

main().then((code) => process.exit(code)).catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
