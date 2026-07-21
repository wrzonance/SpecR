// src/api/onboarding-header-footer-openapi.test.ts
//
// #307 — OnboardingReport (src/lib/jobs.ts) gains a required `headerFooter`
// field: the parsed HeaderFooterComposition draft (or null), surfaced so a
// spec editor can review it during onboarding before saving it (as-is or
// edited) via the existing PUT .../header-footer scope routes (#208/#480).
// openapi.yaml is the hand-authored, live contract (ADR-026); this file pins
// two structural invariants a future edit could silently violate:
//
//   1. Schema/runtime agreement: a full GET /libraries/import/jobs/{jobId}
//      200 response — the only route that ever returns an OnboardingReport —
//      validates against the dereferenced openapi.yaml schema both when
//      headerFooter is null (non-DOCX / no captured composition) and when it
//      carries a real HeaderFooterComposition, and FAILS validation when the
//      field is omitted (it is required, mirroring styleDerivation).
//   2. OnboardingReport.headerFooter is documented with the exact same
//      `oneOf [$ref HeaderFooterComposition, type: 'null']` shape as its
//      styleDerivation sibling — not the `allOf` pattern used for the
//      differently-scoped SpecTree.headerFooter (that field is absent, not
//      null, when there is no composition; see
//      header-footer-warning-openapi.test.ts).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { assertResponse, loadRawSpec } from '../test-utils/contract/validate-response.js';

const ROUTE = '/libraries/import/jobs/{jobId}';

const OnboardingReportSchema = z.object({
  components: z.object({
    schemas: z.object({
      OnboardingReport: z.object({
        required: z.array(z.string()),
        properties: z.object({
          headerFooter: z.object({
            oneOf: z.array(z.unknown()),
          }),
          styleDerivation: z.object({
            oneOf: z.array(z.unknown()),
          }),
          highlightReview: z.object({ $ref: z.string() }),
        }),
      }),
    }),
  }),
});

function baseReport(headerFooter: unknown): Record<string, unknown> {
  return {
    styleDerivation: null,
    styleSourceNeeded: true,
    headerFooter,
    editability: {
      counts: { locked: 0, editable: 0, choice: 0, note: 0 },
      lowConfidence: [],
    },
    highlightReview: { total: 0, findings: [] },
    hierarchy: {
      counts: { scored: 0, unscored: 0, belowThreshold: 0 },
      lowConfidence: [],
    },
    parseWarnings: [],
  };
}

function jobBody(report: Record<string, unknown>): Record<string, unknown> {
  return {
    success: true,
    data: {
      jobId: '11111111-1111-4111-8111-111111111111',
      status: 'complete',
      progress: { stage: 'complete', pct: 100 },
      expiresAt: 1_700_000_000_000,
      result: {
        specId: '22222222-2222-4222-8222-222222222222',
        section: '09 91 26',
        title: 'Painting',
        libraryId: '33333333-3333-4333-8333-333333333333',
        templateId: null,
        report,
      },
    },
  };
}

describe('openapi.yaml — OnboardingReport.headerFooter (#307)', () => {
  it('validates a job response whose report.headerFooter is null (non-DOCX / no composition)', async () => {
    await expect(
      assertResponse('get', ROUTE, 200, jobBody(baseReport(null)))
    ).resolves.toBeUndefined();
  });

  it('validates a job response whose report.headerFooter is a real composition', async () => {
    const composition = {
      pageNumbering: { mode: 'continuous' },
      header: { left: { content: [{ kind: 'sectionTitle' }] } },
    };
    await expect(
      assertResponse('get', ROUTE, 200, jobBody(baseReport(composition)))
    ).resolves.toBeUndefined();
  });

  it('rejects a job response whose report omits headerFooter (now required)', async () => {
    const report = baseReport(null);
    delete report['headerFooter'];
    await expect(assertResponse('get', ROUTE, 200, jobBody(report))).rejects.toThrow(
      /does not match/
    );
  });

  it('OnboardingReport.headerFooter mirrors styleDerivation: oneOf [$ref, null], both required', async () => {
    const raw = await loadRawSpec();
    const { OnboardingReport } = OnboardingReportSchema.parse(raw).components.schemas;

    expect(OnboardingReport.required).toContain('headerFooter');
    expect(OnboardingReport.required).toContain('styleDerivation');

    const headerFooterRef = z
      .object({ $ref: z.string() })
      .parse(OnboardingReport.properties.headerFooter.oneOf[0]);
    expect(headerFooterRef.$ref).toBe('#/components/schemas/HeaderFooterComposition');

    const nullBranch = z
      .object({ type: z.literal('null') })
      .parse(OnboardingReport.properties.headerFooter.oneOf[1]);
    expect(nullBranch.type).toBe('null');
  });

  it('requires the highlight review report in every completed onboarding result', async () => {
    const raw = await loadRawSpec();
    const { OnboardingReport } = OnboardingReportSchema.parse(raw).components.schemas;
    expect(OnboardingReport.required).toContain('highlightReview');
    expect(OnboardingReport.properties.highlightReview.$ref).toBe(
      '#/components/schemas/HighlightReviewReport'
    );
  });
});
