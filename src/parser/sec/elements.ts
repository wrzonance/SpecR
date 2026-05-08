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
  readonly TXT?: string | readonly string[];
  readonly LST?: string | readonly string[];
  readonly ITM?: string | readonly string[];
  readonly OLG?: { readonly OLI?: string | readonly string[] };
  readonly NTE?: NteNode | readonly NteNode[];
  readonly SPT?: SptNode | readonly SptNode[];
  readonly REF?: RefNode | readonly RefNode[];
}

export interface PrtNode {
  readonly TTL?: string;
  readonly SPT?: SptNode | readonly SptNode[];
  readonly NTE?: NteNode | readonly NteNode[];
}
