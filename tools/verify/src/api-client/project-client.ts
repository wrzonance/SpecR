// Project-provisioning API-client methods for the visual round-trip
// verification harness's header/footer fixture pipeline (#305 task 2/7):
// POST /projects, POST /projects/{id}/specs, PUT /projects/{id}/header-footer.
// Same validation discipline as client.ts's original methods (see
// http.ts's docstring) — every response this module hands back has already
// been Zod-parsed.

import { assertOk, doFetch, parseJson } from './http.js';
import type { RequestContext } from './http.js';
import {
  AddSectionToProjectResponseSchema,
  CreateProjectResponseSchema,
  PutHeaderFooterResponseSchema,
  type AddSectionToProjectResult,
  type HeaderFooterConfig,
} from './schemas.js';

// The fixture harness's own outbound shape for PUT .../header-footer — a
// deliberately narrow slice of openapi.yaml's HeaderFooterComposition
// (additionalProperties: true throughout, so this narrower shape is still a
// valid request body). Defined here, not in fixtures/header-footer-
// scenarios.ts (#305 task 3/7), because this is the wire-body type
// putProjectHeaderFooter actually sends — the fixtures module imports this
// type rather than redeclaring an incompatible one.
//
// BUILD FIX (found live during task 7/7's smoke test): a header/footer
// REGION position (e.g. `header.center`) is a CELL wrapping a `content`
// ARRAY of fields (src/ast/header-footer-schemas.ts's HeaderFooterCellSchema),
// never a bare field object. An earlier draft put the field directly at
// `header.center` — the real API's `.catchall(JsonValue)` on that schema
// happily accepted it as an object with unknown extra keys and an absent
// `content`, so PUT/GET both round-tripped it without error, but the
// generator's `buildRegionChildren` reads `cell.content` and found nothing:
// every one of #305's 5 scenarios generated with zero headers/footers in the
// output OOXML before this fix (jszip-confirmed against a real
// POST /specs/{id}/generate — no headerReference/footerReference at all),
// even though the composition round-tripped "successfully" end to end. Not
// repo-root src/ drift: openapi.yaml and the real handler already agree on
// the Cell shape; this was tools/verify's own wire-shape modeling bug.
// Discriminated union rather than a flat interface with optional `text`: a
// 'literal' field is meaningless without its text, so requiring it here
// makes `{ kind: 'literal' }` a compile error instead of silently rendering
// an empty header/footer downstream (see resolveFieldText). The resolved
// field kinds ('sectionNumber' | 'sectionTitle') carry no text of their own.
export type HeaderFooterFieldInput =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'sectionNumber' | 'sectionTitle' };

export interface HeaderFooterCellInput {
  readonly content: readonly HeaderFooterFieldInput[];
}

export interface HeaderFooterVariantInput {
  readonly header?: { readonly center?: HeaderFooterCellInput };
  readonly footer?: { readonly center?: HeaderFooterCellInput };
}

export interface HeaderFooterCompositionInput {
  readonly variants?: {
    readonly default?: HeaderFooterVariantInput;
    readonly first?: HeaderFooterVariantInput;
    readonly even?: HeaderFooterVariantInput;
  };
  readonly pageNumbering?: {
    readonly mode: 'continuous' | 'restartPerSpec';
    readonly startAt?: number;
  };
}

export async function createProject(
  ctx: RequestContext,
  name: string,
  sourceLibraryIds: readonly string[]
): Promise<{ projectId: string }> {
  const response = await doFetch(
    ctx,
    '/projects',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, sourceLibraryIds }),
    },
    'import'
  );
  await assertOk(response, '/projects', 'import');
  const body = await parseJson(response, CreateProjectResponseSchema, '/projects', 'import');
  return { projectId: body.data.projectId };
}

export async function addSectionToProject(
  ctx: RequestContext,
  projectId: string,
  section: string
): Promise<AddSectionToProjectResult> {
  const path = `/projects/${projectId}/specs`;
  const response = await doFetch(
    ctx,
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section }),
    },
    'import'
  );
  await assertOk(response, path, 'import');
  const body = await parseJson(response, AddSectionToProjectResponseSchema, path, 'import');
  return body.data;
}

export async function putProjectHeaderFooter(
  ctx: RequestContext,
  projectId: string,
  composition: HeaderFooterCompositionInput
): Promise<HeaderFooterConfig> {
  const path = `/projects/${projectId}/header-footer`;
  const response = await doFetch(
    ctx,
    path,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(composition),
    },
    'import'
  );
  await assertOk(response, path, 'import');
  const body = await parseJson(response, PutHeaderFooterResponseSchema, path, 'import');
  return body.data;
}
