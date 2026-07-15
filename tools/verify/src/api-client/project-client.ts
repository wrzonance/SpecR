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
export interface HeaderFooterFieldInput {
  readonly kind: 'literal' | 'sectionNumber' | 'sectionTitle';
  readonly text?: string;
}

export interface HeaderFooterVariantInput {
  readonly header?: { readonly center?: HeaderFooterFieldInput };
  readonly footer?: { readonly center?: HeaderFooterFieldInput };
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
