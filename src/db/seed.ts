import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { normalizeSectionNumber } from '../lib/section-number.js';

// Provenance: see docs/adr/013-csi-sections-seed-public-domain-derivation.md
const UFGS_DIR = join(process.cwd(), 'docs/references/UFGS');

export interface SectionRecord {
  readonly sectionNumber: string;
  readonly title: string;
  readonly division: string;
}

export interface CollectResult {
  readonly records: readonly SectionRecord[];
  readonly scanned: number;
}

// Optional leading whitespace + optional 'SECTION ' keyword: real corpus files
// carry both a bare SCN (2 files omit the keyword) and a leading space before it
// (e.g. 26_29_23.SEC: `<SCN> SECTION 26 29 23</SCN>`). The capture is anchored to
// a digit, so [^<]* cannot backtrack past </SCN> — no ReDoS.
const SCN_RE = /<SCN>\s*(?:SECTION\s+)?(\d[^<]*)<\/SCN>/i;
const STL_RE = /<STL>([^<]+)<\/STL>/;

export function extractSectionMeta(content: string): SectionRecord | null {
  const scnMatch = SCN_RE.exec(content);
  const stlMatch = STL_RE.exec(content);

  if (!scnMatch?.[1] || !stlMatch?.[1]) return null;

  // Catalog rows must be canonical — the shape CHECK constraint (migration 013)
  // enforces this at the DB layer; skipping here keeps the seed loud-and-clean.
  const sectionNumber = normalizeSectionNumber(scnMatch[1]);
  if (sectionNumber === null) return null;

  const title = stlMatch[1].trim();
  const division = sectionNumber.slice(0, 2);

  return { sectionNumber, title, division };
}

/**
 * Pure extraction over a batch of file contents. `scanned` counts every input;
 * `records` holds only the canonical ones. A gap between the two is the
 * silent-truncation signal the seed warns on.
 */
export function collectFromContents(contents: readonly string[]): CollectResult {
  const records = contents
    .map((content) => extractSectionMeta(content))
    .filter((record): record is SectionRecord => record !== null);

  return { records, scanned: contents.length };
}

async function collectDivisionRecords(divPath: string): Promise<CollectResult> {
  const entries = await readdir(divPath, { withFileTypes: true });
  const secFiles = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sec')
  );
  const contents = await Promise.all(
    secFiles.map((entry) => readFile(join(divPath, entry.name), 'latin1'))
  );

  return collectFromContents(contents);
}

async function collectRecords(): Promise<CollectResult> {
  const entries = await readdir(UFGS_DIR, { withFileTypes: true });
  const records: SectionRecord[] = [];
  let scanned = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const division = await collectDivisionRecords(join(UFGS_DIR, entry.name));
    records.push(...division.records);
    scanned += division.scanned;
  }

  return { records, scanned };
}

async function seed(pool: Pool): Promise<void> {
  const { logger } = await import('../lib/logger.js');
  const { DatabaseError } = await import('./index.js');

  logger.info('seeding CSI section reference data');

  const { records, scanned } = await collectRecords();
  logger.info({ count: records.length }, 'collected section records');

  if (scanned > records.length) {
    logger.warn(
      { scanned, kept: records.length, skipped: scanned - records.length },
      'section files skipped during seed'
    );
  }

  try {
    for (const { sectionNumber, title, division } of records) {
      await pool.query(
        `INSERT INTO spec_sections (section_number, title, division)
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
