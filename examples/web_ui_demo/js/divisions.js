// MasterFormat division vocabulary shared by the Editor rail and the
// Constellation map. Mirrors the server's umbrella helpers
// (src/db/queries/umbrella-callouts.ts): a division's umbrella section is its
// "NN 00 00" division-wide requirements section.

// MasterFormat 2018 division titles (the set that appears in construction
// specs; gaps in the numbering are reserved divisions).
export const DIVISION_NAMES = {
  '00': 'PROCUREMENT & CONTRACTING',
  '01': 'GENERAL REQUIREMENTS',
  '02': 'EXISTING CONDITIONS',
  '03': 'CONCRETE',
  '04': 'MASONRY',
  '05': 'METALS',
  '06': 'WOOD, PLASTICS & COMPOSITES',
  '07': 'THERMAL & MOISTURE PROTECTION',
  '08': 'OPENINGS',
  '09': 'FINISHES',
  '10': 'SPECIALTIES',
  '11': 'EQUIPMENT',
  '12': 'FURNISHINGS',
  '13': 'SPECIAL CONSTRUCTION',
  '14': 'CONVEYING EQUIPMENT',
  '21': 'FIRE SUPPRESSION',
  '22': 'PLUMBING',
  '23': 'HVAC',
  '25': 'INTEGRATED AUTOMATION',
  '26': 'ELECTRICAL',
  '27': 'COMMUNICATIONS',
  '28': 'ELECTRONIC SAFETY & SECURITY',
  '31': 'EARTHWORK',
  '32': 'EXTERIOR IMPROVEMENTS',
  '33': 'UTILITIES',
  '34': 'TRANSPORTATION',
  '35': 'WATERWAY & MARINE',
  '40': 'PROCESS INTERCONNECTIONS',
  '41': 'MATERIAL PROCESSING & HANDLING',
  '43': 'PROCESS GAS & LIQUID EQUIPMENT',
  '44': 'POLLUTION & WASTE CONTROL',
  '46': 'WATER & WASTEWATER EQUIPMENT',
  '48': 'ELECTRICAL POWER GENERATION',
};

export function divisionOf(section) {
  return section.slice(0, 2);
}

export function divisionName(division) {
  return DIVISION_NAMES[division] || `DIVISION ${division}`;
}

// The division-wide requirements section every other section in the division
// implicitly falls under. Agency-suffixed sections (UFGS "01 32 01.00 10")
// still roll up to the plain "01 00 00" umbrella.
export function umbrellaSection(division) {
  return `${division} 00 00`;
}

export function isUmbrella(section) {
  return section === umbrellaSection(divisionOf(section));
}
