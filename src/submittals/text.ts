export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function stripCsiPrefix(text: string): string {
  return normalizeText(text)
    .replace(/^\d+(?:\.\d+)*\s+/, '')
    .replace(/^[A-Za-z]\.\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^[a-z][.)]\s+/, '')
    .trim();
}

export function titleCase(text: string): string {
  return stripCsiPrefix(text)
    .toLowerCase()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

export function normalizedKey(text: string): string {
  return stripCsiPrefix(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
