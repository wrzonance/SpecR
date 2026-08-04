// Shared walker used by both length-limit-unit-convention.test.ts gates
// (src/api and src/mcp, #642/ADR-091). Deliberately structure-agnostic: it
// descends through every object value and array element rather than
// following a known JSON Schema shape (properties/items/combinators), so a
// `maxLength` behind a `$defs`/`$ref` (which Zod emits for any schema
// carrying `.meta({ id })`) or an as-yet-unused keyword is still found.

export interface LengthField {
  readonly path: string;
  readonly maxLength: number;
  readonly description: string;
  /** Raw JSON Schema node this bound was found on, for reading extra `.meta()` keys (e.g. the `x-length-unit` marker). */
  readonly node: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** This node's own `maxLength`, if it declares one. */
function ownLengthField(node: Record<string, unknown>, path: string): LengthField[] {
  const max = node['maxLength'];
  if (typeof max !== 'number') return [];
  const description = node['description'];
  return [
    {
      path,
      maxLength: max,
      description: typeof description === 'string' ? description : '',
      node,
    },
  ];
}

/** Recursively collect every `maxLength` anywhere in a JSON Schema document/node. */
export function collectLengthFields(node: unknown, path: string): LengthField[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => collectLengthFields(item, `${path}[${index}]`));
  }
  if (!isRecord(node)) return [];
  return [
    ...ownLengthField(node, path),
    ...Object.entries(node).flatMap(([key, value]) => collectLengthFields(value, `${path}.${key}`)),
  ];
}
