import type { CsiNode, CsiTree, NodeType } from '../ast/types.js';

export function getLabel(type: NodeType, index: number, partNumber = 1): string {
  switch (type) {
    case 'part':    return `PART ${index + 1} -`;
    case 'article': return `${partNumber}.${index + 1}`;
    case 'pr1':     return `${String.fromCharCode(65 + index)}.`;
    case 'pr2':     return `${index + 1}.`;
    case 'pr3':     return `${String.fromCharCode(97 + index)}.`;
    case 'pr4':     return `${index + 1})`;
    case 'pr5':     return `${String.fromCharCode(97 + index)})`;
    default:        return '';
  }
}

const INDENT = '   ';

function renderPrNode(node: CsiNode, index: number, depth: number): string {
  if (node.type === 'note' || node.meta.vanish) {
    return `\n> **[NOTE]** ${node.text}`;
  }
  if (node.type === 'continuation') {
    return `\n${INDENT.repeat(depth)}${node.text}`;
  }
  const pad = INDENT.repeat(depth);
  const label = getLabel(node.type, index);
  const lines = [`\n${pad}${label} ${node.text}`];
  node.children.forEach((child, i) => lines.push(renderPrNode(child, i, depth + 1)));
  return lines.join('');
}

function renderArticle(node: CsiNode, index: number, partNumber: number): string {
  const label = getLabel('article', index, partNumber);
  const lines = [`\n### ${label} ${node.text}\n`];
  node.children.forEach((child, i) => lines.push(renderPrNode(child, i, 0)));
  return lines.join('');
}

function renderPart(node: CsiNode, index: number): string {
  const label = getLabel('part', index);
  const lines = [`\n## ${label} ${node.text}\n`];
  node.children.forEach((child, i) => lines.push(renderArticle(child, i, index + 1)));
  return lines.join('');
}

export function renderMarkdown(tree: CsiTree): string {
  const lines = [`# SECTION ${tree.section} — ${tree.title}`];
  tree.parts.forEach((part, i) => lines.push(renderPart(part, i)));
  return lines.join('\n');
}
