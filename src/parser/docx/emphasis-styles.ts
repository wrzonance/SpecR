import { asRecord, compact, extractAttrStr, getAttrVal, toArray } from './xml-utils.js';
import type { RunEmphasisStyle, StyleInfo } from './types.js';

const MAX_BASED_ON_DEPTH = 20;

interface EmphasisStyle {
  readonly basedOn?: string;
  readonly runEmphasis?: RunEmphasisStyle;
}

function toggle(element: unknown): boolean | undefined {
  if (element === undefined) return undefined;
  const record = asRecord(element);
  const value = record ? extractAttrStr(record, '@_w:val').toLowerCase() : '';
  return !['0', 'false', 'off'].includes(value);
}

function sizeOf(rPr: Record<string, unknown>): number | undefined {
  const value = getAttrVal(rPr['w:sz']);
  if (value === '') return undefined;
  const size = Number.parseInt(value, 10);
  return Number.isNaN(size) ? undefined : size;
}

export function parseRunEmphasis(
  rPr: Record<string, unknown> | undefined
): RunEmphasisStyle | undefined {
  if (!rPr) return undefined;
  const bold = toggle(rPr['w:b']);
  const italic = toggle(rPr['w:i']);
  const underlineElement = rPr['w:u'];
  const underline =
    underlineElement === undefined ? undefined : getAttrVal(underlineElement) || 'single';
  const size = sizeOf(rPr);
  const emphasis = compact({ bold, italic, underline, size }) as RunEmphasisStyle;
  return Object.keys(emphasis).length > 0 ? emphasis : undefined;
}

export function defaultRunEmphasis(root: Record<string, unknown>): RunEmphasisStyle {
  const docDefaults = asRecord(root['w:docDefaults']);
  const rPrDefault = asRecord(docDefaults?.['w:rPrDefault']);
  return parseRunEmphasis(asRecord(rPrDefault?.['w:rPr'])) ?? {};
}

export function defaultParagraphStyleId(root: Record<string, unknown>): string | undefined {
  for (const value of toArray(root['w:style'])) {
    const style = asRecord(value);
    if (!style || extractAttrStr(style, '@_w:type') !== 'paragraph') continue;
    const isDefault = ['1', 'true', 'on'].includes(
      extractAttrStr(style, '@_w:default').toLowerCase()
    );
    if (isDefault) return extractAttrStr(style, '@_w:styleId') || undefined;
  }
  return undefined;
}

function resolveChain(
  styleId: string,
  styles: ReadonlyMap<string, EmphasisStyle>,
  defaults: RunEmphasisStyle,
  depth: number
): RunEmphasisStyle {
  if (depth > MAX_BASED_ON_DEPTH) return defaults;
  const style = styles.get(styleId);
  if (!style) return defaults;
  const inherited = style.basedOn
    ? resolveChain(style.basedOn, styles, defaults, depth + 1)
    : defaults;
  return style.runEmphasis ? applyEmphasisStyle(inherited, style.runEmphasis) : inherited;
}

function resolvedToggle(
  inherited: boolean | undefined,
  declared: boolean | undefined
): boolean | undefined {
  if (declared === undefined) return inherited;
  if (!declared) return false;
  return !(inherited ?? false);
}

/** Apply one OOXML style level. Bold and italic toggle inherited values; other
 * run properties replace them. Direct run formatting is handled separately. */
export function applyEmphasisStyle(
  inherited: RunEmphasisStyle,
  declared: RunEmphasisStyle
): RunEmphasisStyle {
  const bold = resolvedToggle(inherited.bold, declared.bold);
  const italic = resolvedToggle(inherited.italic, declared.italic);
  const underline = declared.underline ?? inherited.underline;
  const size = declared.size ?? inherited.size;
  return {
    ...(bold !== undefined ? { bold } : {}),
    ...(italic !== undefined ? { italic } : {}),
    ...(underline !== undefined ? { underline } : {}),
    ...(size !== undefined ? { size } : {}),
  };
}

function characterStyles(root: Record<string, unknown>): ReadonlyMap<string, EmphasisStyle> {
  const entries = toArray(root['w:style']).flatMap((value) => {
    const style = asRecord(value);
    if (!style || extractAttrStr(style, '@_w:type') !== 'character') return [];
    const styleId = extractAttrStr(style, '@_w:styleId');
    if (!styleId) return [];
    const basedOn = getAttrVal(style['w:basedOn']);
    const runEmphasis = parseRunEmphasis(asRecord(style['w:rPr']));
    const info: EmphasisStyle = {
      ...(basedOn ? { basedOn } : {}),
      ...(runEmphasis ? { runEmphasis } : {}),
    };
    return [[styleId, info] as const];
  });
  return new Map(entries);
}

function styleChain(
  styleId: string,
  styles: ReadonlyMap<string, EmphasisStyle>,
  depth: number
): readonly RunEmphasisStyle[] {
  if (depth > MAX_BASED_ON_DEPTH) return [];
  const style = styles.get(styleId);
  if (!style) return [];
  const inherited = style.basedOn ? styleChain(style.basedOn, styles, depth + 1) : [];
  return style.runEmphasis ? [...inherited, style.runEmphasis] : inherited;
}

export function characterRunEmphasisChainMap(
  root: Record<string, unknown>
): ReadonlyMap<string, readonly RunEmphasisStyle[]> {
  const styles = characterStyles(root);
  return new Map([...styles.keys()].map((styleId) => [styleId, styleChain(styleId, styles, 0)]));
}

export function resolvedRunEmphasisMap(
  styles: ReadonlyMap<string, StyleInfo>,
  defaults: RunEmphasisStyle
): ReadonlyMap<string, RunEmphasisStyle> {
  return new Map(
    [...styles.keys()].map((styleId) => [styleId, resolveChain(styleId, styles, defaults, 0)])
  );
}
