import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const files = await readdir(divPath);
  const records: SectionRecord[] = [];

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.sec')) continue;
    const content = await readFile(join(divPath, file), 'latin1');
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

async function seed(): Promise<void> {
  const { pool } = await import('./index.js');
  const { logger } = await import('../lib/logger.js');

  logger.info('seeding CSI section reference data');

  const records = await collectRecords();
  logger.info({ count: records.length }, 'collected section records');

  for (const { sectionNumber, title, division } of records) {
    await pool.query(
      `INSERT INTO csi_sections (section_number, title, division)
       VALUES ($1, $2, $3)
       ON CONFLICT (section_number) DO UPDATE SET title = EXCLUDED.title`,
      [sectionNumber, title, division]
    );
  }

  logger.info({ count: records.length }, 'seeded CSI sections');
  await pool.end();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  seed().catch(async (err: unknown) => {
    const { logger } = await import('../lib/logger.js');
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
}
