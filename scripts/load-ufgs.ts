import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool } from '../src/db/index.js';
import { insertTree, insertRefs } from '../src/db/index.js';
import { parseSec } from '../src/parser/index.js';
import type { CsiNode } from '../src/ast/types.js';

const UFGS_DIR = join(process.cwd(), 'docs/references/UFGS');

interface LoadSuccess {
  readonly section: string;
  readonly nodeCount: number;
  readonly refCount: number;
}

interface LoadFailure {
  readonly file: string;
  readonly error: string;
}

function countNodes(nodes: readonly CsiNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children), 0);
}

async function collectFiles(): Promise<string[]> {
  const divs = await readdir(UFGS_DIR, { withFileTypes: true });
  const files: string[] = [];
  for (const div of divs) {
    if (!div.isDirectory()) continue;
    const entries = await readdir(join(UFGS_DIR, div.name), { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.sec')) {
        files.push(join(UFGS_DIR, div.name, e.name));
      }
    }
  }
  return files.sort();
}

async function loadFile(
  file: string,
  pool: ReturnType<typeof createPool>
): Promise<LoadSuccess> {
  const xml = await readFile(file, 'latin1');
  const { tree, refs } = parseSec(xml);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete existing paragraphs and refs before re-inserting (idempotent)
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM specs WHERE section = $1 AND source = 'ufgs'`,
      [tree.section]
    );
    if (existing.rows[0]) {
      await client.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [existing.rows[0].id]);
      await client.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [existing.rows[0].id]);
    }

    const specResult = await client.query<{ id: string }>(
      `INSERT INTO specs (section, title, source)
       VALUES ($1, $2, 'ufgs')
       ON CONFLICT (section, source) DO UPDATE
         SET title = EXCLUDED.title, updated_at = now()
       RETURNING id`,
      [tree.section, tree.title]
    );
    const specId = specResult.rows[0]?.id;
    if (!specId) throw new Error('spec upsert returned no id');

    await insertTree(tree, specId, client);
    await insertRefs(refs, specId, client);

    await client.query('COMMIT');

    const nodeCount = countNodes(tree.parts);
    return { section: tree.section, nodeCount, refCount: refs.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const files = await collectFiles();
    console.log(`Found ${files.length} .SEC files`);

    const successes: LoadSuccess[] = [];
    const failures: LoadFailure[] = [];

    for (const file of files) {
      try {
        const result = await loadFile(file, pool);
        successes.push(result);
        console.log(`✓ ${result.section}  ${result.nodeCount} nodes  ${result.refCount} refs`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ file, error: msg });
        console.error(`✗ ${file}: ${msg}`);
      }
    }

    const totalNodes = successes.reduce((s, r) => s + r.nodeCount, 0);
    const totalRefs = successes.reduce((s, r) => s + r.refCount, 0);
    console.log(
      `\nLoaded ${successes.length}/${files.length} specs  ${totalNodes} paragraphs  ${totalRefs} refs`
    );
    if (failures.length > 0) {
      console.error(`\nFailed (${failures.length}):`);
      for (const f of failures) console.error(`  ${f.file}: ${f.error}`);
    }

    process.exit(failures.length > 0 ? 1 : 0);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
