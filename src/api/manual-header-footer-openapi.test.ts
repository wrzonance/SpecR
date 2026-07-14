// src/api/manual-header-footer-openapi.test.ts
//
// #481 — generateManualHandler (POST /projects/{id}/generate) and both
// revision render paths behind generateRevisionHandler (POST
// /revisions/{id}/generate) now resolve and render header/footer content
// (src/api/generate.ts, src/generator/index.ts). openapi.yaml is the
// hand-authored, live contract (ADR-026): its prose for both operations
// predates that wiring — the manual endpoint's description never mentioned
// header/footer at all, and the revision endpoint's description explicitly
// claimed "Running DOCX headers/footers are reserved for the header/footer
// foundation work," which is now false. This file pins the corrected prose
// directly against the dereferenced spec so a future doc edit that
// re-introduces either gap fails here first, not in a spec-editor's hands.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { loadSpec, type OpenApiDoc } from '../test-utils/contract/validate-response.js';

const OperationSchema = z.object({ description: z.string().optional() });

function descriptionOf(doc: OpenApiDoc, path: string, method: string): string {
  const raw = doc.paths[path]?.[method];
  if (raw === undefined) throw new Error(`missing openapi operation: ${method} ${path}`);
  return OperationSchema.parse(raw).description ?? '';
}

describe('openapi.yaml — manual/revision header-footer rendering (#481)', () => {
  it('/projects/{id}/generate documents header/footer rendering as in scope', async () => {
    const doc = await loadSpec();
    const description = descriptionOf(doc, '/projects/{id}/generate', 'post');
    expect(description).toMatch(/header\/footer/i);
    expect(description).toMatch(/resolved and rendered|rendered into every section/i);
    expect(description).not.toMatch(/reserved for the header\/footer foundation work/i);
  });

  it('/revisions/{id}/generate documents header/footer rendering as in scope, keyed on the target revision', async () => {
    const doc = await loadSpec();
    const description = descriptionOf(doc, '/revisions/{id}/generate', 'post');
    expect(description).toMatch(/header\/footer/i);
    // The stale #304-era claim this replaces — must not survive the edit.
    expect(description).not.toMatch(/reserved for the header\/footer foundation work/i);
    expect(description).not.toMatch(/cover\/front matter only/i);
    // Addendum mode resolves from the target revision being rendered, never
    // from baseRevisionId — pin the direction, not just the topic.
    expect(description).toMatch(/target revision/i);
  });

  it('front-matter/cover section stays deliberately headerless (documented, not silently implied)', async () => {
    const doc = await loadSpec();
    const description = descriptionOf(doc, '/projects/{id}/generate', 'post');
    expect(description).toMatch(/cover page.*(no header|headerless)|headerless.*cover/is);
  });
});
