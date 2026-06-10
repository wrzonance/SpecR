// Shared OOXML attribute extraction helpers for fast-xml-parser output.
// fast-xml-parser represents w:val attributes as { '@_w:val': string | number }.

export function getAttrVal(obj: unknown): string {
  if (obj !== null && typeof obj === 'object' && '@_w:val' in obj) {
    const v = (obj as Record<string, unknown>)['@_w:val'];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export function getAttrNumVal(obj: unknown): number {
  const n = parseInt(getAttrVal(obj), 10);
  return isNaN(n) ? 0 : n;
}

// Safely extract a top-level attribute value from a parsed XML record.
// fast-xml-parser stores w:abstractNumId as '@_w:abstractNumId' with string or number value.
export function extractAttrStr(record: Record<string, unknown>, key: string): string {
  const val = record[key];
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

export function toArray<T>(val: T | readonly T[] | undefined): readonly T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? (val as readonly T[]) : [val as T];
}

// Narrow an unknown fast-xml-parser node to a Record, or undefined if not an object.
export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}
