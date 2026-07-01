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

function coverageNotes(divisions: readonly string[]): readonly string[] {
  const unique = [...new Set(divisions)].sort((a, b) => a.localeCompare(b));
  return unique.length === 0
    ? []
    : [`umbrella call-out check covers all divisions in scope: ${unique.join(', ')}`];
}

export function buildUmbrellaCalloutFindings(
  present: readonly UmbrellaPresentSpec[],
  sectionRefs: readonly UmbrellaSectionRef[]
): UmbrellaCalloutResult {
  const grouped = refsBySource(sectionRefs);
  // Resolve each spec's division once, then derive both findings and the
  // coverage note from that single pass (no repeated divisionOf scan).
  const withDivision = present.flatMap((spec) => {
    const division = divisionOf(spec.section);
    return division === null ? [] : [{ spec, division }];
  });
  const findings = withDivision.flatMap(({ spec, division }) => {
    const finding = checkedFinding(spec, division, grouped);
    return finding === null ? [] : [finding];
  });
  return { findings, notes: coverageNotes(withDivision.map(({ division }) => division)) };
}
