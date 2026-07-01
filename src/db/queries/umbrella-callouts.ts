export interface UmbrellaPresentSpec {
  readonly specId: string;
  readonly section: string;
}

export interface UmbrellaSectionRef {
  readonly sourceSpecId: string;
  readonly value: string;
}

export interface UmbrellaNotCalledOutFinding {
  readonly type: 'umbrella_not_called_out';
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly umbrellaSpecSection: string;
}

export interface UmbrellaCalloutResult {
  readonly findings: readonly UmbrellaNotCalledOutFinding[];
  readonly notes: readonly string[];
}

function divisionOf(section: string): string | null {
  const match = /^(\d{2}) /.exec(section);
  return match?.[1] ?? null;
}

function umbrellaSection(division: string): string {
  return `${division} 00 00`;
}

function isUmbrella(section: string, division: string): boolean {
  return section === umbrellaSection(division);
}

function refsBySource(
  refs: readonly UmbrellaSectionRef[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const ref of refs) {
    const existing = grouped.get(ref.sourceSpecId) ?? new Set<string>();
    grouped.set(ref.sourceSpecId, new Set([...existing, ref.value]));
  }
  return grouped;
}

function hasUmbrellaRef(
  specId: string,
  umbrella: string,
  grouped: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  return grouped.get(specId)?.has(umbrella) ?? false;
}

function checkedFinding(
  spec: UmbrellaPresentSpec,
  division: string,
  grouped: ReadonlyMap<string, ReadonlySet<string>>
): UmbrellaNotCalledOutFinding | null {
  const umbrella = umbrellaSection(division);
  if (isUmbrella(spec.section, division) || hasUmbrellaRef(spec.specId, umbrella, grouped)) {
    return null;
  }
  return {
    type: 'umbrella_not_called_out',
    sourceSpecId: spec.specId,
    sourceSpecSection: spec.section,
    umbrellaSpecSection: umbrella,
  };
}

function coveredDivisions(present: readonly UmbrellaPresentSpec[]): readonly string[] {
  const divisions = new Set<string>();
  for (const spec of present) {
    const division = divisionOf(spec.section);
    if (division !== null) divisions.add(division);
  }
  return [...divisions].sort((a, b) => a.localeCompare(b));
}

function coverageNotes(present: readonly UmbrellaPresentSpec[]): readonly string[] {
  const divisions = coveredDivisions(present);
  return divisions.length === 0
    ? []
    : [`umbrella call-out check covers all divisions in scope: ${divisions.join(', ')}`];
}

export function buildUmbrellaCalloutFindings(
  present: readonly UmbrellaPresentSpec[],
  sectionRefs: readonly UmbrellaSectionRef[]
): UmbrellaCalloutResult {
  const grouped = refsBySource(sectionRefs);
  const findings = present.flatMap((spec) => {
    const division = divisionOf(spec.section);
    if (division === null) return [];
    const finding = checkedFinding(spec, division, grouped);
    return finding === null ? [] : [finding];
  });
  return { findings, notes: coverageNotes(present) };
}
