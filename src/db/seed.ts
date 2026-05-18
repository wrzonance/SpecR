import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// Provenance: see docs/adr/013-csi-sections-seed-public-domain-derivation.md
const UFGS_DIR = join(process.cwd(), 'docs/references/UFGS');

export interface SectionRecord {
  readonly sectionNumber: string;
  readonly title: string;
  readonly division: string;
}

const SCN_RE = /<SCN>SECTION ([^<]+)<\/SCN>/;
const STL_RE = /<STL>([^<]+)<\/STL>/;

export function extractSectionMeta(content: string): SectionRecord | null {
  const scnMatch = SCN_RE.exec(content);
  const stlMatch = STL_RE.exec(content);

  if (!scnMatch?.[1] || !stlMatch?.[1]) return null;

  const sectionNumber = scnMatch[1].trim();
  const title = stlMatch[1].trim();
  const division = sectionNumber.slice(0, 2);

  return { sectionNumber, title, division };
}

async function collectDivisionRecords(divPath: string): Promise<SectionRecord[]> {
  const entries = await readdir(divPath, { withFileTypes: true });
  const records: SectionRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.sec')) continue;
    const content = await readFile(join(divPath, entry.name), 'latin1');
    const record = extractSectionMeta(content);
    if (record !== null) records.push(record);
  }

  return records;
}

async function collectRecords(): Promise<SectionRecord[]> {
  const entries = await readdir(UFGS_DIR, { withFileTypes: true });
  const all: SectionRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const divRecords = await collectDivisionRecords(join(UFGS_DIR, entry.name));
    all.push(...divRecords);
  }

  return all;
}

async function seed(pool: Pool): Promise<void> {
  const { logger } = await import('../lib/logger.js');
  const { DatabaseError } = await import('./index.js');

  logger.info('seeding CSI section reference data');

  const records = await collectRecords();
  logger.info({ count: records.length }, 'collected section records');

  try {
    for (const { sectionNumber, title, division } of records) {
      await pool.query(
        `INSERT INTO csi_sections (section_number, title, division)
         VALUES ($1, $2, $3)
         ON CONFLICT (section_number) DO UPDATE SET title = EXCLUDED.title`,
        [sectionNumber, title, division]
      );
    }
  } catch (err) {
    throw new DatabaseError('failed to upsert section records', { cause: err });
  }

  logger.info({ count: records.length }, 'seeded CSI sections');
}

const isMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (isMain) {
  void (async () => {
    const { pool } = await import('./index.js');
    seed(pool)
      .then(() => pool.end())
      .catch(async (err: unknown) => {
        const { logger } = await import('../lib/logger.js');
        logger.error({ err }, 'seed failed');
        process.exit(1);
      });
  })();
}
