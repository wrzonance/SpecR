import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getReferenceGraph } from './reference-graph-read.js';
import { getOutboundReferences } from './refs.js';
import { ProjectNotFoundError } from './derive.js';
import { LibraryNotFoundError } from './libraries.js';

const suffix = randomUUID().slice(0, 8);
const source = `rg_${suffix}`;
const specIds: string[] = [];
let projectId: string;
let libraryId: string;
let umbrella: string; // 09 00 00
let painting: string; // 09 91 00 (calls out umbrella + cites 07 92 00 twice)
let gypsum: string; // 09 29 00 (does not call out umbrella; dangling ref to 99 99 00)

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [section, title, `${source}_${section}`, libraryId]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`insertSpec returned no id for ${section}`);
  specIds.push(id);
  return id;
}
async function addProjectSpec(specId: string, position: number): Promise<void> {
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,$3)`, [
    projectId,
    specId,
    position,
  ]);
}
async function insertRef(
  sourceSpecId: string,
  targetSection: string,
  targetSpecId: string | null
): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1',$2,1) RETURNING id`,
    [sourceSpecId, `ref ${targetSection}`]
  );
  const paragraphId = p.rows[0]?.id;
  if (paragraphId === undefined) throw new Error('insert paragraph returned no id');
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text, is_broken)
     VALUES ($1,$2,'section',$3,$4,$5,$6)`,
    [
      sourceSpecId,
      paragraphId,
      targetSection,
      targetSpecId,
      `ref ${targetSection}`,
      targetSpecId === null,
    ]
  );
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`RefGraph Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`RefGraph Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;

  umbrella = await insertSpec('09 00 00', 'Finishes General');
  painting = await insertSpec('09 91 00', 'Painting');
  gypsum = await insertSpec('09 29 00', 'Gypsum Board');
  await addProjectSpec(umbrella, 1);
  await addProjectSpec(painting, 2);
  await addProjectSpec(gypsum, 3);

  // painting -> 09 00 00 (umbrella, in scope), painting -> 07 92 00 twice (dangling)
  await insertRef(painting, '09 00 00', umbrella);
  await insertRef(painting, '07 92 00', null);
  await insertRef(painting, '07 92 00', null);
  // gypsum -> 99 99 00 (dangling), no umbrella call-out
  await insertRef(gypsum, '99 99 00', null);
});

afterAll(async () => {
  // Drop the project first (cascades project_specs) so specs are unreferenced,
  // then the specs (cascades paragraphs + spec_references), then the library.
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
});

describe('getReferenceGraph (project scope)', () => {
  it('returns nodes, resolved/dangling edges, citation counts, and umbrella annotations', async () => {
    const g = await getReferenceGraph({ kind: 'project', id: projectId });
    expect(g.nodes.map((n) => n.section)).toEqual(['09 00 00', '09 29 00', '09 91 00']);
    expect(g.nodes.find((n) => n.specId === umbrella)?.isUmbrella).toBe(true);
    const twoCite = g.edges.find(
      (e) => e.sourceSpecId === painting && e.targetSection === '07 92 00'
    );
    expect(twoCite?.citationCount).toBe(2);
    expect(twoCite?.targetSpecId).toBeNull();
    const resolved = g.edges.find(
      (e) => e.sourceSpecId === painting && e.targetSection === '09 00 00'
    );
    expect(resolved?.targetSpecId).toBe(umbrella);
    const div09 = g.umbrella.find((u) => u.division === '09');
    expect(div09?.umbrellaPresent).toBe(true);
    expect(div09?.umbrellaSpecId).toBe(umbrella);
    expect(div09?.notCalledOut.map((s) => s.specId)).toEqual([gypsum]);
  });

  it('agrees with getOutboundReferences for each source spec (section refs)', async () => {
    const g = await getReferenceGraph({ kind: 'project', id: projectId });
    // Cover every source spec — painting (resolved + dangling refs) and gypsum
    // (dangling only) — so the dangling-edge agreement case is exercised too.
    for (const specId of [painting, gypsum]) {
      const outbound = await getOutboundReferences(specId, projectId, pool);
      const bySection = new Map<string, { count: number; targetSpecId: string | null }>();
      for (const o of outbound) {
        if (o.targetSection === null) continue;
        const cur = bySection.get(o.targetSection) ?? { count: 0, targetSpecId: o.targetSpecId };
        bySection.set(o.targetSection, { count: cur.count + 1, targetSpecId: o.targetSpecId });
      }
      expect(bySection.size).toBeGreaterThan(0);
      for (const [section, expected] of bySection) {
        const edge = g.edges.find((e) => e.sourceSpecId === specId && e.targetSection === section);
        expect(edge?.citationCount).toBe(expected.count);
        expect(edge?.targetSpecId ?? null).toBe(expected.targetSpecId ?? null);
      }
    }
  });

  it('includes capped anchors when includeAnchors is set', async () => {
    const g = await getReferenceGraph({ kind: 'project', id: projectId }, { includeAnchors: true });
    const twoCite = g.edges.find(
      (e) => e.sourceSpecId === painting && e.targetSection === '07 92 00'
    );
    expect(twoCite?.anchors).toHaveLength(2);
    expect(twoCite?.anchorsTruncated).toBe(false);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(getReferenceGraph({ kind: 'project', id: randomUUID() })).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
  });
});

describe('getReferenceGraph (library scope)', () => {
  it('returns library-scoped nodes and throws for an unknown library', async () => {
    const g = await getReferenceGraph({ kind: 'library', id: libraryId });
    expect(g.nodes.map((n) => n.section)).toEqual(['09 00 00', '09 29 00', '09 91 00']);
    await expect(getReferenceGraph({ kind: 'library', id: randomUUID() })).rejects.toBeInstanceOf(
      LibraryNotFoundError
    );
  });
});
