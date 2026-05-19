import { LevelFormat, AlignmentType } from 'docx';
import type { NodeType } from '../ast/types.js';

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

export function buildSpecNumberingConfig() {
  return {
    reference: 'spec-numbering' as const,
    levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: 'PART %1 -', alignment: AlignmentType.START },
      { level: 1, format: LevelFormat.DECIMAL, text: '%1.%2', alignment: AlignmentType.START },
      { level: 2, format: LevelFormat.UPPER_LETTER, text: '%3.', alignment: AlignmentType.START },
      { level: 3, format: LevelFormat.DECIMAL, text: '%4.', alignment: AlignmentType.START },
      { level: 4, format: LevelFormat.LOWER_LETTER, text: '%5.', alignment: AlignmentType.START },
      { level: 5, format: LevelFormat.DECIMAL, text: '%6)', alignment: AlignmentType.START },
      { level: 6, format: LevelFormat.LOWER_LETTER, text: '%7)', alignment: AlignmentType.START },
    ],
  };
}
