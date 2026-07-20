type ProjectRowAlias = 'p' | 'u';

interface EffectiveSectionNumberFormatSql {
  readonly select: string;
  readonly clientJoin: string;
}

/** Shared project → client → canonical section-number-format resolution. */
export function effectiveSectionNumberFormatSql(
  projectAlias: ProjectRowAlias
): EffectiveSectionNumberFormatSql {
  return {
    select: `COALESCE(${projectAlias}.section_number_format, c.section_number_format, 'canonical')`,
    clientJoin: `LEFT JOIN clients c ON c.id = ${projectAlias}.client_id`,
  };
}
