// Inverse of parser/sec/entities.ts decodeXmlEntities.
//
// The renderer writes its own XML strings (no serializer library), so every
// run of text placed inside an element body or attribute must escape the five
// XML metacharacters. Encoding is the exact inverse the parser decodes: a
// literal "&" becomes "&amp;", so a round-tripped "O&M" survives as "O&M" and a
// literal "&amp;" survives as "&amp;amp;" — never a tag-injection vector.
//
// Order matters: "&" is replaced first so the entities introduced for the other
// four characters are not themselves re-escaped.

export function encodeXmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
