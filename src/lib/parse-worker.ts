import { parse } from '../parser/index.js';
import type { SpecTree, SecRef } from '../ast/types.js';

export interface WorkerInput {
  readonly buffer: Buffer;
  readonly ext: string;
}

export interface WorkerOutput {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly capabilities?: readonly string[];
}

// Delegates to the parse() orchestrator so the upload path runs the same
// pipeline as CLI ingest — including lib/infer-section section/title recovery,
// which this worker previously skipped (DOCX uploads whose docProps/core.xml
// carries no metadata persisted section='unknown').
// Format safety validation (assertSecSafe/assertDocxSafe) already ran in the
// main thread before the job was created.
export default async function parseWorker({ buffer, ext }: WorkerInput): Promise<WorkerOutput> {
  const { tree, refs, capabilities } = await parse(buffer, `upload${ext}`);
  return { tree, refs, ...(capabilities !== undefined ? { capabilities } : {}) };
}
