import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool } from '../index.js';
import {
  upsertMapping,
  deleteMapping,
  getMappingsBySpec,
  getMappingsByInstance,
  getMappingsByParagraph,
} from './revit.js';

// Two specs, three paragraphs across them — exercise the cross-spec fan-out
// the design doc calls out: one Revit instance touches multiple specs.
const SPEC_A = 'a0000000-0000-0000-0000-00000000a001';
const SPEC_B = 'a0000000-0000-0000-0000-00000000a002';
const PARA_A1 = 'a0000000-0000-0000-0000-00000000b001';
const PARA_A2 = 'a0000000-0000-0000-0000-00000000b002';
const PARA_B1 = 'a0000000-0000-0000-0000-00000000b003';
const INSTANCE_ID = 'revit-instance-data-outlet-a';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source) VALUES
       ($1, '27 11 00', 'Revit Test Spec A', 'arcat'),
       ($2, '26 05 33', 'Revit Test Spec B', 'arcat')
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_A, SPEC_B]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position) VALUES
       ($1, $4, NULL,  'pr1', 'Manufacturer placeholder', 1),
       ($2, $4, NULL,  'pr1', 'Port count placeholder', 2),
       ($3, $5, NULL,  'pr1', 'Conduit size placeholder', 1)
     ON CONFLICT (id) DO NOTHING`,
    [PARA_A1, PARA_A2, PARA_B1, SPEC_A, SPEC_B]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id IN ($1, $2)', [SPEC_A, SPEC_B]);
});

beforeEach(async () => {
  // Truncate mapping rows between tests so each test starts from a clean slate
  // without dropping the seeded specs/paragraphs. CASCADE-safe via FK chain.
  await pool.query('DELETE FROM revit_parameter_mappings WHERE paragraph_id IN ($1, $2, $3)', [
    PARA_A1,
    PARA_A2,
    PARA_B1,
  ]);
});

describe('upsertMapping', () => {
  it('inserts a mapping with defaults and returns full row', async () => {
    const row = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'faceplate',
      revitParam: 'Manufacturer',
      transformType: 'replace',
    });
    expect(row.paragraphId).toBe(PARA_A1);
    expect(row.revitInstanceId).toBe(INSTANCE_ID);
    expect(row.revitComponentRole).toBe('faceplate');
    expect(row.revitParam).toBe('Manufacturer');
    expect(row.direction).toBe('to_spec'); // default
    expect(row.transformType).toBe('replace');
    expect(row.transformConfig).toBeNull();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('round-trips JSONB transform_config', async () => {
    const cfg = { template: '{{value}} per spec', uppercase: true };
    const row = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'jack',
      revitParam: 'Category',
      transformType: 'placeholder',
      transformConfig: cfg,
    });
    expect(row.transformConfig).toEqual(cfg);
  });

  it('is idempotent on natural key (paragraph + instance + role + param)', async () => {
    const first = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'faceplate',
      revitParam: 'Manufacturer',
      transformType: 'replace',
    });
    const second = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'faceplate',
      revitParam: 'Manufacturer',
      transformType: 'append',
      transformConfig: { suffix: ' (per Revit)' },
    });
    expect(second.id).toBe(first.id);
    expect(second.transformType).toBe('append');
    expect(second.transformConfig).toEqual({ suffix: ' (per Revit)' });
    const all = await getMappingsByParagraph(PARA_A1);
    expect(all).toHaveLength(1);
  });

  it('treats NULL revit_component_role as equal under NULLS NOT DISTINCT', async () => {
    const first = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: null,
      revitParam: 'TypeName',
      transformType: 'replace',
    });
    // omit revitComponentRole — should also resolve to NULL and collide.
    const second = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitParam: 'TypeName',
      transformType: 'placeholder',
    });
    expect(second.id).toBe(first.id);
    expect(second.transformType).toBe('placeholder');
    const all = await getMappingsByParagraph(PARA_A1);
    expect(all).toHaveLength(1);
    expect(all[0]!.revitComponentRole).toBeNull();
  });

  it('keeps family-instance-level and component-level rows distinct', async () => {
    await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: null,
      revitParam: 'TypeName',
      transformType: 'replace',
    });
    await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'faceplate',
      revitParam: 'TypeName',
      transformType: 'replace',
    });
    const all = await getMappingsByParagraph(PARA_A1);
    expect(all).toHaveLength(2);
  });
});

describe('getMappingsByInstance / BySpec / ByParagraph', () => {
  beforeEach(async () => {
    // One Revit instance fans out across two specs + multiple paragraphs.
    await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'faceplate',
      revitParam: 'Manufacturer',
      transformType: 'replace',
    });
    await upsertMapping({
      paragraphId: PARA_A2,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'jack',
      revitParam: 'PortCount',
      transformType: 'placeholder',
    });
    await upsertMapping({
      paragraphId: PARA_B1,
      revitInstanceId: INSTANCE_ID,
      revitComponentRole: 'conduit',
      revitParam: 'TradeSize',
      transformType: 'replace',
    });
    // A second instance, only on spec A — verifies filtering.
    await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: 'revit-instance-other',
      revitComponentRole: 'faceplate',
      revitParam: 'Manufacturer',
      transformType: 'replace',
    });
  });

  it('getMappingsByInstance returns all mappings across specs for one instance', async () => {
    const rows = await getMappingsByInstance(INSTANCE_ID);
    expect(rows).toHaveLength(3);
    const params = rows.map((r) => r.revitParam).sort((a, b) => a.localeCompare(b));
    expect(params).toEqual(['Manufacturer', 'PortCount', 'TradeSize']);
  });

  it('getMappingsBySpec returns mappings for paragraphs in that spec only', async () => {
    const specA = await getMappingsBySpec(SPEC_A);
    expect(specA).toHaveLength(3); // 2 from INSTANCE_ID + 1 from other
    const specB = await getMappingsBySpec(SPEC_B);
    expect(specB).toHaveLength(1);
    expect(specB[0]!.paragraphId).toBe(PARA_B1);
  });

  it('getMappingsByParagraph returns only that paragraph’s mappings', async () => {
    const rows = await getMappingsByParagraph(PARA_A1);
    expect(rows).toHaveLength(2);
    const instances = rows.map((r) => r.revitInstanceId).sort((a, b) => a.localeCompare(b));
    expect(instances).toEqual(
      [INSTANCE_ID, 'revit-instance-other'].sort((a, b) => a.localeCompare(b))
    );
  });

  it('returns empty arrays for unknown ids', async () => {
    expect(await getMappingsBySpec('00000000-0000-0000-0000-000000000000')).toEqual([]);
    expect(await getMappingsByInstance('does-not-exist')).toEqual([]);
    expect(await getMappingsByParagraph('00000000-0000-0000-0000-000000000000')).toEqual([]);
  });
});

describe('deleteMapping', () => {
  it('removes a mapping by id', async () => {
    const row = await upsertMapping({
      paragraphId: PARA_A1,
      revitInstanceId: INSTANCE_ID,
      revitParam: 'Manufacturer',
      transformType: 'replace',
    });
    await deleteMapping(row.id);
    expect(await getMappingsByParagraph(PARA_A1)).toEqual([]);
  });

  it('is a no-op for an unknown id', async () => {
    await expect(deleteMapping('00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
  });
});

describe('FK cascades', () => {
  it('deletes mappings when paragraph is deleted', async () => {
    const TEMP_PARA = 'a0000000-0000-0000-0000-00000000c001';
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, NULL, 'pr1', 'temp', 99)`,
      [TEMP_PARA, SPEC_A]
    );
    await upsertMapping({
      paragraphId: TEMP_PARA,
      revitInstanceId: INSTANCE_ID,
      revitParam: 'TmpParam',
      transformType: 'replace',
    });
    await pool.query('DELETE FROM paragraphs WHERE id = $1', [TEMP_PARA]);
    expect(await getMappingsByParagraph(TEMP_PARA)).toEqual([]);
  });

  it('deletes mappings when spec is deleted (cascade through paragraph)', async () => {
    const TEMP_SPEC = 'a0000000-0000-0000-0000-00000000d001';
    const TEMP_PARA = 'a0000000-0000-0000-0000-00000000d002';
    await pool.query(
      `INSERT INTO specs (id, section, title, source)
       VALUES ($1, '99 99 99', 'cascade test', 'arcat')`,
      [TEMP_SPEC]
    );
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, NULL, 'pr1', 'cascade', 1)`,
      [TEMP_PARA, TEMP_SPEC]
    );
    await upsertMapping({
      paragraphId: TEMP_PARA,
      revitInstanceId: INSTANCE_ID,
      revitParam: 'CascadeParam',
      transformType: 'replace',
    });
    await pool.query('DELETE FROM specs WHERE id = $1', [TEMP_SPEC]);
    expect(await getMappingsBySpec(TEMP_SPEC)).toEqual([]);
    expect(await getMappingsByParagraph(TEMP_PARA)).toEqual([]);
  });
});

describe('CHECK constraints (enforced by Postgres, asserted via raw SQL)', () => {
  it('rejects invalid direction values', async () => {
    await expect(
      pool.query(
        `INSERT INTO revit_parameter_mappings
           (paragraph_id, revit_instance_id, revit_param, direction, transform_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [PARA_A1, INSTANCE_ID, 'BadDir', 'sideways', 'replace']
      )
    ).rejects.toThrow(/direction/i);
  });

  it('rejects invalid transform_type values', async () => {
    await expect(
      pool.query(
        `INSERT INTO revit_parameter_mappings
           (paragraph_id, revit_instance_id, revit_param, transform_type)
         VALUES ($1, $2, $3, $4)`,
        [PARA_A1, INSTANCE_ID, 'BadType', 'merge']
      )
    ).rejects.toThrow(/transform_type/i);
  });

  it('accepts all four reserved direction values', async () => {
    const directions = ['to_spec', 'to_revit', 'bidirectional', 'spec_only'] as const;
    for (const direction of directions) {
      const row = await upsertMapping({
        paragraphId: PARA_A1,
        revitInstanceId: INSTANCE_ID,
        revitComponentRole: `role-${direction}`,
        revitParam: 'dirParam',
        direction,
        transformType: 'replace',
      });
      expect(row.direction).toBe(direction);
    }
  });
});
