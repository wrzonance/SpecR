// Re-exported for merge consumers' convenience; canonical definition is src/ast/types.ts
export type { ParagraphSnapshot } from '../ast/types.js';

export interface TrackChangeRecord {
  readonly kind: 'ins' | 'del';
  readonly uuid?: string | undefined; // enclosing w:sdt tag if present
  readonly text: string;
  readonly author?: string | undefined;
  readonly date?: string | undefined; // w:date attr, ISO
}

export interface ExtractResult {
  /** uuid → plain text (post virtual-accept of track changes) */
  readonly controlled: ReadonlyMap<string, string>;
  /** non-empty paragraphs outside any specr-uuid w:sdt, with document-order index */
  readonly orphans: readonly {
    readonly text: string;
    readonly index: number;
    /** nearest preceding controlled uuid in document order, undefined if none */
    readonly afterUuid: string | undefined;
  }[];
  readonly trackChanges: {
    readonly present: boolean;
    readonly records: readonly TrackChangeRecord[];
  };
}

export interface ParagraphDiff {
  /** synthesized via uuidGen at diff time */
  readonly uuid: string;
  readonly text: string;
  /** document order in theirs */
  readonly index: number;
  /** nearest preceding controlled uuid in document order, undefined if none */
  readonly afterUuid: string | undefined;
}

export interface ModifiedDiff {
  readonly uuid: string;
  readonly base: string;
  readonly theirs: string;
  readonly ours: string;
}

/** Same shape as ModifiedDiff; presence in conflicts[] signals the kind. */
export type ConflictDiff = ModifiedDiff;

export interface DiffResult {
  readonly added: readonly ParagraphDiff[];
  readonly modified: readonly ModifiedDiff[];
  /** uuids present in base but absent from theirs */
  readonly deleted: readonly string[];
  readonly conflicts: readonly ConflictDiff[];
  readonly warnings: readonly string[];
}

export type UuidGen = () => string;
