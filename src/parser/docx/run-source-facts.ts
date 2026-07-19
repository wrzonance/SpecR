import { asRecord, extractAttrStr } from './xml-utils.js';

export interface RunSourceProperties {
  readonly colors: readonly string[];
  readonly vanish: boolean;
}

function childNodes(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function findElement(nodes: readonly unknown[], tag: string): Record<string, unknown> | undefined {
  for (const raw of nodes) {
    const record = asRecord(raw);
    if (record && Object.prototype.hasOwnProperty.call(record, tag)) return record;
  }
  return undefined;
}

function orderedAttr(record: Record<string, unknown>, key: string): string {
  const attrs = asRecord(record[':@']);
  return attrs ? extractAttrStr(attrs, key) : '';
}

function normalizeRunColor(value: string): string | null {
  const color = value.trim();
  const lower = color.toLowerCase();
  if (!color || lower === 'auto' || lower === '000000') return null;
  return /^[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : color;
}

function normalizeHighlight(value: string): string | null {
  const highlight = value.trim();
  if (!highlight || highlight.toLowerCase() === 'none') return null;
  return `highlight:${highlight}`;
}

function isOnOffActive(element: Record<string, unknown> | undefined): boolean {
  if (!element) return false;
  const value = orderedAttr(element, '@_w:val').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

export function sourcePropertiesForRun(runChildren: readonly unknown[]): RunSourceProperties {
  const rPr = findElement(runChildren, 'w:rPr');
  const props = rPr ? childNodes(rPr, 'w:rPr') : [];
  const color = findElement(props, 'w:color');
  const highlight = findElement(props, 'w:highlight');
  const colors = [
    color ? normalizeRunColor(orderedAttr(color, '@_w:val')) : null,
    highlight ? normalizeHighlight(orderedAttr(highlight, '@_w:val')) : null,
  ].filter((token): token is string => token !== null);
  return { colors, vanish: isOnOffActive(findElement(props, 'w:vanish')) };
}
