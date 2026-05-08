export type NodeType =
  | 'spec'
  | 'part'
  | 'article'
  | 'pr1'
  | 'pr2'
  | 'pr3'
  | 'pr4'
  | 'pr5'
  | 'note'
  | 'continuation';

export interface CsiNodeMeta {
  readonly vanish?: boolean;
  readonly source?: 'ufgs' | 'arcat' | 'masterspec' | 'unknown';
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
