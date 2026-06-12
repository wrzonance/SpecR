import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D2/D3 backfill (issue #94) — existing projects alias shared library
// rows. This migration (1) gives every project the built-in company master as
// its sole source (governs FUTURE resolution only), and (2) clones every
// aliased TOC row into a project-owned copy with full lineage + the paragraph
// origin map, then repoints project_specs. Same SQL clone pattern as runtime
// (src/db/queries/derive.ts) — frozen snapshot, no src/ imports.
//
// Aborts loudly if a project TOC holds the same section via two specs — the
// (section, project_id) unique index forbids two clones of one section;
// resolve duplicates manually (precedent: migration 016 down).

function seedProjectSources(pgm: MigrationBuilder): void {
  // Only sourceless projects — a no-op guard on first run (nothing has sources
  // before 019), and replay-safe after a down: projects that gained their own
  // source lists post-019 are skipped instead of tripping the PK / priority
  // unique constraints.
  pgm.sql(`
    INSERT INTO project_sources (project_id, library_id, priority)
    SELECT p.id, (SELECT id FROM libraries WHERE name = 'Default Company Master'), 1
    FROM projects p
    WHERE NOT EXISTS (SELECT 1 FROM project_sources ps WHERE ps.project_id = p.id)
  `);
}

function buildCloneMaps(pgm: MigrationBuilder): void {
  // One clone id per aliased (project, master) join row.
  pgm.sql(`
    CREATE TEMP TABLE backfill_clone_map AS
    SELECT ps.project_id, ps.spec_id AS master_id, gen_random_uuid() AS clone_id
    FROM project_specs ps
    JOIN specs s ON s.id = ps.spec_id
    WHERE s.library_id IS NOT NULL
  `);

  // Paragraph trees: UUID map per clone.
  pgm.sql(`
    CREATE TEMP TABLE backfill_para_map AS
    SELECT cm.clone_id, p.id AS old_id, gen_random_uuid() AS new_id
    FROM backfill_clone_map cm
    JOIN paragraphs p ON p.spec_id = cm.master_id
  `);
}

function cloneSpecs(pgm: MigrationBuilder): void {
  pgm.sql(`
    INSERT INTO specs (id, section, title, source, project_id, library_id,
                       parent_spec_id, origin_version, content_version, origin_meta)
    SELECT cm.clone_id, s.section, s.title, s.source, cm.project_id, NULL,
           s.id, s.content_version, 1, s.origin_meta
    FROM backfill_clone_map cm
    JOIN specs s ON s.id = cm.master_id
  `);
}

function cloneParagraphs(pgm: MigrationBuilder): void {
  // Parent remapped within the same clone via the para map.
  pgm.sql(`
    INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position,
                            vanish, revit_param, base_version, conflicts, origin_paragraph_id)
    SELECT pm.new_id, pm.clone_id, parent.new_id, p.node_type, p.text, p.position,
           p.vanish, p.revit_param, p.base_version, p.conflicts, p.id
    FROM backfill_para_map pm
    JOIN paragraphs p ON p.id = pm.old_id
    LEFT JOIN backfill_para_map parent
      ON parent.old_id = p.parent_id AND parent.clone_id = pm.clone_id
  `);
}

function cloneRefs(pgm: MigrationBuilder): void {
  // Pass 1: section targets provisionally broken; intra-spec paragraph targets
  // remapped, cross-spec paragraph targets NULL (scoped tpm join cannot match
  // another spec's paragraphs).
  pgm.sql(`
    INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type,
                                 target_spec_section, target_spec_id, target_paragraph_id,
                                 standard_code, reference_text, is_broken)
    SELECT cm.clone_id, spm.new_id, sr.target_type, sr.target_spec_section,
           NULL, tpm.new_id, sr.standard_code, sr.reference_text,
           (sr.target_type = 'section')
    FROM spec_references sr
    JOIN backfill_clone_map cm ON cm.master_id = sr.source_spec_id
    JOIN backfill_para_map spm
      ON spm.old_id = sr.source_paragraph_id AND spm.clone_id = cm.clone_id
    LEFT JOIN backfill_para_map tpm
      ON tpm.old_id = sr.target_paragraph_id AND tpm.clone_id = cm.clone_id
  `);

  // Repoint the TOC to the clones (position preserved — only spec_id changes).
  pgm.sql(`
    UPDATE project_specs ps
    SET spec_id = cm.clone_id
    FROM backfill_clone_map cm
    WHERE ps.project_id = cm.project_id AND ps.spec_id = cm.master_id
  `);

  // Pass 2: re-resolve section targets project-scope now that all of each
  // project's clones exist. Only clone refs match — nothing else has
  // project_id set before this migration.
  pgm.sql(`
    UPDATE spec_references sr
    SET target_spec_id = t.id, is_broken = false
    FROM specs src, specs t
    WHERE sr.source_spec_id = src.id
      AND src.project_id IS NOT NULL
      AND sr.target_type = 'section'
      AND t.project_id = src.project_id
      AND t.section = sr.target_spec_section
  `);
}

export const up = (pgm: MigrationBuilder): void => {
  seedProjectSources(pgm);
  buildCloneMaps(pgm);
  cloneSpecs(pgm);
  cloneParagraphs(pgm);
  cloneRefs(pgm);
  pgm.sql(`DROP TABLE backfill_clone_map`);
  pgm.sql(`DROP TABLE backfill_para_map`);
};

export const down = (pgm: MigrationBuilder): void => {
  // Repoint TOC rows back at the masters, then delete ALL project-owned specs
  // (their paragraphs and outgoing refs cascade). Post-migration edits to
  // clones are lost on down — documented and accepted (design doc #94);
  // rollback is a dev-time operation.
  pgm.sql(`
    UPDATE project_specs ps
    SET spec_id = s.parent_spec_id
    FROM specs s
    WHERE s.id = ps.spec_id
      AND s.project_id IS NOT NULL
      AND s.parent_spec_id IS NOT NULL
  `);
  pgm.sql(`DELETE FROM specs WHERE project_id IS NOT NULL`);
  // Remove only the seeded shape — a sole default-company source at priority 1.
  // Projects whose source lists diverged post-019 (any other row) are left
  // intact rather than wiped; the guarded up() seed skips them on replay.
  pgm.sql(`
    DELETE FROM project_sources ps
    WHERE ps.library_id = (SELECT id FROM libraries WHERE name = 'Default Company Master')
      AND ps.priority = 1
      AND NOT EXISTS (
        SELECT 1 FROM project_sources o
        WHERE o.project_id = ps.project_id AND o.library_id <> ps.library_id
      )
  `);
};
