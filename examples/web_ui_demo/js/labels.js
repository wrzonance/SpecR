// CSI label scheme — a faithful port of src/generator/markdown.ts getLabel().
// index is the node's 0-based position within its parent's children array
// (notes and continuations consume an index, exactly as the generator does).

function alphaLabel(index, upper) {
  let n = index + 1;
  let out = '';
  const base = upper ? 65 : 97;
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(base + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function getLabel(type, index, partNumber = 1) {
  switch (type) {
    case 'part':
      return `PART ${index + 1} -`;
    case 'article':
      return `${partNumber}.${index + 1}`;
    case 'pr1':
      return `${alphaLabel(index, true)}.`;
    case 'pr2':
      return `${index + 1}.`;
    case 'pr3':
      return `${alphaLabel(index, false)}.`;
    case 'pr4':
    case 'pr6':
      return `${index + 1})`;
    case 'pr5':
    case 'pr7':
      return `${alphaLabel(index, false)})`;
    default:
      return '';
  }
}
