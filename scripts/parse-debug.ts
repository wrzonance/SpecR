import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from '../src/parser/docx/index.js';
import type { SpecNode } from '../src/ast/types.js';

const filePath = process.argv[2];
if (!filePath) {
  process.stderr.write('Usage: pnpm tsx scripts/parse-debug.ts <file.docx>\n');
  process.exit(1);
}

function countNodes(nodes: readonly SpecNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

function printTree(nodes: readonly SpecNode[], depth = 0): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth);
    const preview = node.text.slice(0, 55).replace(/\n/g, ' ');
    const label = `[${node.type}, src:${node.meta.source ?? '?'}]`;
    process.stdout.write(`${indent}${preview.padEnd(58)}${label}\n`);
    printTree(node.children, depth + 1);
  }
}

async function main(): Promise<void> {
  const buffer = readFileSync(resolve(filePath));
  const tree = await parseDocx(buffer);
  const nodeCount = countNodes(tree.parts);

  process.stdout.write(`\nParsed:  ${tree.section} — ${tree.title}\n`);
  process.stdout.write(`Source:  ${tree.parts[0]?.meta.source ?? 'unknown'}\n`);
  process.stdout.write(`Nodes:   ${nodeCount}\n\n`);
  printTree(tree.parts);
  process.stdout.write('\n');
}

void main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
