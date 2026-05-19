import { z } from 'zod';
import { NodeTypeSchema } from './schemas.js';

export type NodeType = z.infer<typeof NodeTypeSchema>;

export interface SpecNodeMeta {
  readonly vanish?: boolean;
  readonly source?: 'ufgs' | 'arcat' | 'cpi' | 'unknown';
  readonly revitParam?: string;
  readonly baseVersion?: number;
}

export interface SpecNode {
  readonly id: string;
  readonly type: NodeType;
  readonly text: string;
  readonly children: readonly SpecNode[];
  readonly meta: SpecNodeMeta;
}

export type ParseWarningType = 'root-continuation' | 'empty-part' | 'no-structure-found';

export interface ParseWarning {
  readonly type: ParseWarningType;
  readonly lineHint?: string;
  readonly suggestion?: string;
}

export interface SpecTree {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly parts: readonly SpecNode[];
  readonly warnings?: readonly ParseWarning[];
}

export type SecRef =
  | {
      readonly sourceNodeId: string;
      readonly targetType: 'section';
      readonly targetSpecSection: string;
      readonly standardCode?: undefined;
      readonly referenceText: string;
    }
  | {
      readonly sourceNodeId: string;
      readonly targetType: 'standard';
      readonly standardCode: string;
      readonly targetSpecSection?: undefined;
      readonly referenceText: string;
    };
