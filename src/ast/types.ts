import { z } from 'zod';
import { NodeTypeSchema } from './schemas.js';

export type NodeType = z.infer<typeof NodeTypeSchema>;

export interface CsiNodeMeta {
  readonly vanish?: boolean;
  readonly source?: 'ufgs' | 'arcat' | 'cpi' | 'unknown';
  readonly revitParam?: string;
  readonly baseVersion?: number;
}

export interface CsiNode {
  readonly id: string;
  readonly type: NodeType;
  readonly text: string;
  readonly children: readonly CsiNode[];
  readonly meta: CsiNodeMeta;
}

export interface CsiTree {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly parts: readonly CsiNode[];
}

export interface SecRef {
  readonly sourceNodeId: string;
  readonly targetType: 'section' | 'standard';
  readonly targetSpecSection?: string;
  readonly standardCode?: string;
  readonly referenceText: string;
}
