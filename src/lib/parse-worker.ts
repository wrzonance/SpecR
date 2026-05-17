import { parseSec, parseDocx, parseText, assertSecSafe } from '../parser/index.js';
import { decodeTextBuffer } from './decode-text.js';
import type { CsiTree } from '../ast/types.js';

export interface WorkerInput {
  readonly buffer: Buffer;
  readonly ext: string;
}

export interface WorkerOutput {
  readonly tree: CsiTree;
  readonly capabilities?: readonly string[];
}

export default async function parseWorker({ buffer, ext }: WorkerInput): Promise<WorkerOutput> {
  if (ext === '.sec') {
    const tree = parseSec(assertSecSafe(buffer)).tree;
    return { tree };
  }
  if (ext === '.txt') {
    const rawText = decodeTextBuffer(buffer);
    const parsed = parseText(rawText);
    return { tree: parsed.tree, capabilities: parsed.capabilities };
  }
  // .docx — validation already performed in main thread
  const tree = await parseDocx(buffer);
  return { tree };
}
