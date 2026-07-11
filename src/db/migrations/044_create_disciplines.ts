import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-065 — discipline mapping (scoped-profile pattern, mirrors editing_conventions #137
// and numbering_profiles #299). `disciplines` is a GLOBAL catalog; `discipline_section_rules`
// maps an inclusive CSI division range to a discipline, scoped per library. Rows with
// `library_id IS NULL` are the built-in default that resolves when a library has no rules
// of its own. Migrations are frozen snapshots — these literals are duplicated here and are
// never imported from src/ runtime code.

// Global discipline catalog — one entry per active CSI MasterFormat division, named by its
// official division title (numbers/titles stable since MasterFormat 2004). `key` is the stable
// API/filter slug; `name` is the display label. "Mechanical" is seeded but unmapped by the
// default rules — it exists as an override target for firms that group the mechanical trades
// (21–23) under one discipline. Firms regroup any way they like via per-library overrides;
// the default bakes in the standard division-level mapping (ADR-065).
const DISCIPLINES: readonly { key: string; name: string }[] = [
  // Facility Services group (21–28) + the "Mechanical" override target.
  { key: 'fire-suppression', name: 'Fire Suppression' },
  { key: 'plumbing', name: 'Plumbing' },
  { key: 'hvac', name: 'HVAC' },
  { key: 'mechanical', name: 'Mechanical' },
  { key: 'integrated-automation', name: 'Integrated Automation' },
  { key: 'electrical', name: 'Electrical' },
  { key: 'communications', name: 'Communications' },
  { key: 'electronic-safety-security', name: 'Electronic Safety & Security' },
  // Procurement/Contracting (00) + General Requirements (01).
  { key: 'procurement-contracting', name: 'Procurement and Contracting Requirements' },
  { key: 'general-requirements', name: 'General Requirements' },
  // Facility Construction subgroup (02–14).
  { key: 'existing-conditions', name: 'Existing Conditions' },
  { key: 'concrete', name: 'Concrete' },
  { key: 'masonry', name: 'Masonry' },
  { key: 'metals', name: 'Metals' },
  { key: 'wood-plastics-composites', name: 'Wood, Plastics, and Composites' },
  { key: 'thermal-moisture-protection', name: 'Thermal and Moisture Protection' },
  { key: 'openings', name: 'Openings' },
  { key: 'finishes', name: 'Finishes' },
  { key: 'specialties', name: 'Specialties' },
  { key: 'equipment', name: 'Equipment' },
  { key: 'furnishings', name: 'Furnishings' },
  { key: 'special-construction', name: 'Special Construction' },
  { key: 'conveying-equipment', name: 'Conveying Equipment' },
  // Site & Infrastructure subgroup (31–35).
  { key: 'earthwork', name: 'Earthwork' },
  { key: 'exterior-improvements', name: 'Exterior Improvements' },
  { key: 'utilities', name: 'Utilities' },
  { key: 'transportation', name: 'Transportation' },
  { key: 'waterway-marine-construction', name: 'Waterway and Marine Construction' },
  // Process Equipment subgroup (40–48).
  { key: 'process-interconnections', name: 'Process Interconnections' },
  { key: 'material-processing-handling', name: 'Material Processing and Handling Equipment' },
  {
    key: 'process-heating-cooling-drying',
    name: 'Process Heating, Cooling, and Drying Equipment',
  },
  {
    key: 'process-gas-liquid-handling',
    name: 'Process Gas and Liquid Handling, Purification, and Storage Equipment',
  },
  { key: 'pollution-waste-control', name: 'Pollution and Waste Control Equipment' },
  { key: 'industry-specific-manufacturing', name: 'Industry-Specific Manufacturing Equipment' },
  { key: 'water-wastewater-equipment', name: 'Water and Wastewater Equipment' },
  { key: 'electrical-power-generation', name: 'Electrical Power Generation' },
];

// Built-in default mapping (library_id IS NULL): every active MasterFormat division →
// its own discipline, at single-division granularity. Reserved divisions (15–20, 24, 29,
// 30, 36–39, 47, 49) get NO rule, so a section in one resolves to a null discipline. Trade
// groupings like 03–14 → Architectural or 21–23 → Mechanical are exactly what per-library
// overrides are for (ADR-065).
const DEFAULT_RULES: readonly { key: string; start: string; end: string }[] = [
  { key: 'procurement-contracting', start: '00', end: '00' },
  { key: 'general-requirements', start: '01', end: '01' },
  { key: 'existing-conditions', start: '02', end: '02' },
  { key: 'concrete', start: '03', end: '03' },
  { key: 'masonry', start: '04', end: '04' },
  { key: 'metals', start: '05', end: '05' },
  { key: 'wood-plastics-composites', start: '06', end: '06' },
  { key: 'thermal-moisture-protection', start: '07', end: '07' },
  { key: 'openings', start: '08', end: '08' },
  { key: 'finishes', start: '09', end: '09' },
  { key: 'specialties', start: '10', end: '10' },
  { key: 'equipment', start: '11', end: '11' },
  { key: 'furnishings', start: '12', end: '12' },
  { key: 'special-construction', start: '13', end: '13' },
  { key: 'conveying-equipment', start: '14', end: '14' },
  { key: 'fire-suppression', start: '21', end: '21' },
  { key: 'plumbing', start: '22', end: '22' },
  { key: 'hvac', start: '23', end: '23' },
  { key: 'integrated-automation', start: '25', end: '25' },
  { key: 'electrical', start: '26', end: '26' },
  { key: 'communications', start: '27', end: '27' },
  { key: 'electronic-safety-security', start: '28', end: '28' },
  { key: 'earthwork', start: '31', end: '31' },
  { key: 'exterior-improvements', start: '32', end: '32' },
  { key: 'utilities', start: '33', end: '33' },
  { key: 'transportation', start: '34', end: '34' },
  { key: 'waterway-marine-construction', start: '35', end: '35' },
  { key: 'process-interconnections', start: '40', end: '40' },
  { key: 'material-processing-handling', start: '41', end: '41' },
  { key: 'process-heating-cooling-drying', start: '42', end: '42' },
  { key: 'process-gas-liquid-handling', start: '43', end: '43' },
  { key: 'pollution-waste-control', start: '44', end: '44' },
  { key: 'industry-specific-manufacturing', start: '45', end: '45' },
  { key: 'water-wastewater-equipment', start: '46', end: '46' },
  { key: 'electrical-power-generation', start: '48', end: '48' },
];

function seedCatalog(pgm: MigrationBuilder): void {
  for (const { key, name } of DISCIPLINES) {
    pgm.sql(`INSERT INTO disciplines (key, name) VALUES ('${key}', '${name.replace(/'/g, "''")}')`);
  }
}

function seedDefaultRules(pgm: MigrationBuilder): void {
  for (const { key, start, end } of DEFAULT_RULES) {
    pgm.sql(
      `INSERT INTO discipline_section_rules (discipline_id, library_id, division_start, division_end)
       SELECT id, NULL, '${start}', '${end}' FROM disciplines WHERE key = '${key}'`
    );
  }
}

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('disciplines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    key: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('disciplines', 'disciplines_key_nonempty', 'CHECK (length(trim(key)) > 0)');
  pgm.addConstraint('disciplines', 'disciplines_name_nonempty', 'CHECK (length(trim(name)) > 0)');

  pgm.createTable('discipline_section_rules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    discipline_id: {
      type: 'uuid',
      notNull: true,
      references: 'disciplines',
      onDelete: 'CASCADE',
    },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' }, // NULL = built-in default
    division_start: { type: 'char(2)', notNull: true },
    division_end: { type: 'char(2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'discipline_section_rules',
    'discipline_section_rules_division_shape',
    "CHECK (division_start ~ '^[0-9]{2}$' AND division_end ~ '^[0-9]{2}$' AND division_start <= division_end)"
  );
  pgm.createIndex('discipline_section_rules', 'library_id', {
    name: 'discipline_section_rules_library_id_idx',
  });
  // No two rules (in the same scope) share a division range — keeps resolution deterministic.
  // Two partial unique indexes because NULL library_id is not comparable via a plain unique.
  pgm.sql(`CREATE UNIQUE INDEX discipline_section_rules_builtin_range
           ON discipline_section_rules (division_start, division_end)
           WHERE library_id IS NULL`);
  pgm.sql(`CREATE UNIQUE INDEX discipline_section_rules_library_range
           ON discipline_section_rules (library_id, division_start, division_end)
           WHERE library_id IS NOT NULL`);

  seedCatalog(pgm);
  seedDefaultRules(pgm);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('discipline_section_rules');
  pgm.dropTable('disciplines');
};
