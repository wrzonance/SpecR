import { parseSec, parseDocx, parseText, assertSecSafe } from '../parser/index.js';
import { extractRefsFromTree } from '../parser/index.js';
import { decodeTextBuffer } from './decode-text.js';
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

export default async function parseWorker({ buffer, ext }: WorkerInput): Promise<WorkerOutput> {
  if (ext === '.sec') {
    const { tree, refs } = parseSec(assertSecSafe(buffer));
    return { tree, refs };
  }
  if (ext === '.txt') {
    const rawText = decodeTextBuffer(buffer);
    const parsed = parseText(rawText);
    return { tree: parsed.tree, refs: parsed.refs, capabilities: parsed.capabilities };
  }
  if (ext === '.docx') {
    // validation already performed in main thread
    const tree = await parseDocx(buffer);
    const refs = extractRefsFromTree(tree);
    return { tree, refs };
  }
  throw new Error(`unsupported extension in parse worker: ${ext}`);
}
