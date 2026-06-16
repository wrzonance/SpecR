import { LevelFormat, AlignmentType } from 'docx';
import type { ILevelsOptions } from 'docx';
import type { NodeType, NumberingDef, StyleNodeType } from '../ast/index.js';
import type { StyleRuleMap } from './styles.js';

export function getNodeLevel(type: NodeType): number | null {
  switch (type) {
    case 'part':
      return 0;
    case 'article':
      return 1;
    case 'pr1':
      return 2;
    case 'pr2':
      return 3;
    case 'pr3':
      return 4;
    case 'pr4':
      return 5;
    case 'pr5':
      return 6;
    default:
      return null;
  }
}

// Index = numbering level; inverse of getNodeLevel for the styleable node types.
const LEVEL_NODE_TYPES: readonly StyleNodeType[] = [
  'part',
  'article',
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
];

type DocxLevelFormat = (typeof LevelFormat)[keyof typeof LevelFormat];

// OOXML numFmt values the generator can render. Unknown values are ignored
// (default kept) — the open JSONB style schema is warn-don't-reject (ADR-021).
const NUM_FMT: Readonly<Record<string, DocxLevelFormat>> = {
  decimal: LevelFormat.DECIMAL,
  upperLetter: LevelFormat.UPPER_LETTER,
  lowerLetter: LevelFormat.LOWER_LETTER,
  upperRoman: LevelFormat.UPPER_ROMAN,
  lowerRoman: LevelFormat.LOWER_ROMAN,
  ordinal: LevelFormat.ORDINAL,
  bullet: LevelFormat.BULLET,
  none: LevelFormat.NONE,
};

function defaultLevels(): ILevelsOptions[] {
  return [
    { level: 0, format: LevelFormat.DECIMAL, text: 'PART %1 -', alignment: AlignmentType.START },
    { level: 1, format: LevelFormat.DECIMAL, text: '%1.%2', alignment: AlignmentType.START },
    { level: 2, format: LevelFormat.UPPER_LETTER, text: '%3.', alignment: AlignmentType.START },
    { level: 3, format: LevelFormat.DECIMAL, text: '%4.', alignment: AlignmentType.START },
    { level: 4, format: LevelFormat.LOWER_LETTER, text: '%5.', alignment: AlignmentType.START },
    { level: 5, format: LevelFormat.DECIMAL, text: '%6)', alignment: AlignmentType.START },
    { level: 6, format: LevelFormat.LOWER_LETTER, text: '%7)', alignment: AlignmentType.START },
  ];
}

// Template `ilvl` is deliberately NOT consulted: it describes the source
// document's numbering; output levels are generator-owned via getNodeLevel.
function applyOverride(level: ILevelsOptions, num: NumberingDef | undefined): ILevelsOptions {
  if (!num) return level;
  const fmt = num.numFmt !== undefined ? NUM_FMT[num.numFmt] : undefined;
  return {
    ...level,
    ...(fmt !== undefined ? { format: fmt } : {}),
    ...(num.lvlText !== undefined ? { text: num.lvlText } : {}),
    ...(num.start !== undefined ? { start: num.start } : {}),
  };
}

// `reference` is parameterized so a multi-section manual can register one
// distinct numbering instance per section — the per-section restart sharp edge
// (ADR-017 Consequences). Single-section generation keeps the 'spec-numbering' default.
export function buildSpecNumberingConfig(
  rules?: StyleRuleMap,
  reference = 'spec-numbering'
): {
  reference: string;
  levels: ILevelsOptions[];
} {
  const levels = defaultLevels().map((level, i) => {
    const nodeType = LEVEL_NODE_TYPES[i];
    return applyOverride(
      level,
      nodeType !== undefined ? rules?.get(nodeType)?.numbering : undefined
    );
  });
  return { reference, levels };
}
