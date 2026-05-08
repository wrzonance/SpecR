// src/parser/sec/elements.ts
// TypeScript interfaces for raw fast-xml-parser output.
// stopNodes elements arrive as raw strings; structural elements are parsed objects.

export interface NteNode {
  readonly NPR?: string | readonly string[];
}

export interface RefNode {
  readonly ORG?: string;
  readonly RID?: string | readonly string[];
  readonly RTL?: string;
}

export interface SptNode {
  readonly TTL?: string;
  readonly TXT?: readonly string[];
  readonly LST?: readonly string[];
  readonly ITM?: readonly string[];
  readonly OLG?: { readonly OLI?: string | readonly string[] };
  readonly NTE?: readonly NteNode[];
  readonly SPT?: readonly SptNode[];
  readonly REF?: readonly RefNode[];
}

export interface PrtNode {
  readonly TTL?: string;
  readonly SPT?: readonly SptNode[];
  readonly NTE?: readonly NteNode[];
}
