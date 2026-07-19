import type { SourceEmphasisProperty, SourceEmphasisValue } from '../../ast/types.js';
import { asRecord, extractAttrStr } from './xml-utils.js';
import type { RunEmphasisStyle, StyleMap } from './types.js';

export interface EmphasisDeviation {
  readonly property: SourceEmphasisProperty;
  readonly value: Exclude<SourceEmphasisValue, null>;
  readonly expected: SourceEmphasisValue;
}

export interface RunSourceProperties {
  readonly colors: readonly string[];
  readonly emphasis: readonly EmphasisDeviation[];
  readonly effective: RunEmphasisStyle;
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

function toggle(element: Record<string, unknown> | undefined): boolean | undefined {
  if (!element) return undefined;
  return !['0', 'false', 'off'].includes(orderedAttr(element, '@_w:val').toLowerCase());
}

function numberValue(element: Record<string, unknown> | undefined): number | undefined {
  if (!element) return undefined;
  const value = Number.parseInt(orderedAttr(element, '@_w:val'), 10);
  return Number.isNaN(value) ? undefined : value;
}

function orderedRunEmphasis(props: readonly unknown[]): RunEmphasisStyle {
  const underlineElement = findElement(props, 'w:u');
  const underline = underlineElement
    ? orderedAttr(underlineElement, '@_w:val') || 'single'
    : undefined;
  const bold = toggle(findElement(props, 'w:b'));
  const italic = toggle(findElement(props, 'w:i'));
  const size = numberValue(findElement(props, 'w:sz'));
  return {
    ...(bold !== undefined ? { bold } : {}),
    ...(italic !== undefined ? { italic } : {}),
    ...(underline !== undefined ? { underline } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function deviation(
  property: SourceEmphasisProperty,
  value: Exclude<SourceEmphasisValue, null> | undefined,
  expected: SourceEmphasisValue
): EmphasisDeviation | null {
  return value !== undefined && value !== expected ? { property, value, expected } : null;
}

function emphasisDeviations(
  direct: RunEmphasisStyle,
  effective: RunEmphasisStyle
): readonly EmphasisDeviation[] {
  return [
    deviation('bold', direct.bold, effective.bold ?? false),
    deviation('italic', direct.italic, effective.italic ?? false),
    deviation('underline', direct.underline, effective.underline ?? 'none'),
    deviation('size', direct.size, effective.size ?? null),
  ].filter((item): item is EmphasisDeviation => item !== null);
}

function runStyleEmphasis(props: readonly unknown[], styleMap: StyleMap): RunEmphasisStyle {
  const rStyle = findElement(props, 'w:rStyle');
  const styleId = rStyle ? orderedAttr(rStyle, '@_w:val') : '';
  return styleMap.resolvedCharacterRunEmphasis?.get(styleId) ?? {};
}

export function effectiveEmphasisForParagraph(
  paragraphChildren: readonly unknown[],
  styleMap: StyleMap
): RunEmphasisStyle {
  const pPr = findElement(paragraphChildren, 'w:pPr');
  const properties = pPr ? childNodes(pPr, 'w:pPr') : [];
  const pStyle = findElement(properties, 'w:pStyle');
  const styleId = pStyle
    ? orderedAttr(pStyle, '@_w:val')
    : (styleMap.defaultParagraphStyleId ?? '');
  return styleMap.resolvedRunEmphasis?.get(styleId) ?? styleMap.defaultRunEmphasis ?? {};
}

export function sourcePropertiesForRun(
  runChildren: readonly unknown[],
  effective: RunEmphasisStyle,
  styleMap: StyleMap
): RunSourceProperties {
  const rPr = findElement(runChildren, 'w:rPr');
  const props = rPr ? childNodes(rPr, 'w:rPr') : [];
  const color = findElement(props, 'w:color');
  const highlight = findElement(props, 'w:highlight');
  const colors = [
    color ? normalizeRunColor(orderedAttr(color, '@_w:val')) : null,
    highlight ? normalizeHighlight(orderedAttr(highlight, '@_w:val')) : null,
  ].filter((token): token is string => token !== null);
  const actual = { ...runStyleEmphasis(props, styleMap), ...orderedRunEmphasis(props) };
  return { colors, emphasis: emphasisDeviations(actual, effective), effective };
}
