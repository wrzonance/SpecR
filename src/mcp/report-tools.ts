import { z } from 'zod';
import { handleCoordinationReport } from './handlers.js';
import { handleCompareSpecs } from './reporting-handler.js';
import type { ToolRegistrar } from './tool-registry.js';

/** Cross-cutting read-only report tools: project coordination (errors &
 *  omissions) and cross-spec comparison (ADR-047). Both are `read` tier. */
export function registerReportTools(reg: ToolRegistrar): void {
  registerCoordinationTool(reg);
  registerCompareTool(reg);
}

function registerCoordinationTool(reg: ToolRegistrar): void {
  reg.register(
    'coordination_report',
    {
      description:
        'Project errors-and-omissions report: required-but-absent sections, ' +
        'present-but-not-required specs, and dangling cross-references. Each ' +
        'dangling_ref pinpoints the source paragraph (sourceParagraphId) and a ' +
        'snippet of the reference in context. Also reports article<->body ' +
        'reference consistency: related_listed_not_cited (a Related Sections ' +
        'entry never cited), related_cited_not_listed (a section cited in the ' +
        'body but not listed), and standard_cited_not_listed (a standard cited ' +
        'but absent from References). Also suggests implied_related_section ' +
        'when a body keyword matches an unlisted in-scope section title. Optional packageId scopes to one design ' +
        'package. Requires a projectId (see list_projects).',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
        packageId: z.uuid().optional().describe('Optional design-package UUID to scope the report'),
      },
    },
    handleCoordinationReport
  );
}

function registerCompareTool(reg: ToolRegistrar): void {
  reg.register(
    'compare_specs',
    {
      description:
        'Grounded, deterministic cross-spec comparison matrix. Aligns exactly two ' +
        'live specs by resolved paragraph origin (origin_paragraph_id ?? id) and ' +
        'returns a symmetric matrix — one row per aligned paragraph, one column per ' +
        'source, each cell the source’s verbatim text or absent. Every present cell ' +
        'traces to a real specId + paragraph UUID; nothing is synthesized. Supports ' +
        'project↔project (shared master program) and project↔master (drift-from-master, ' +
        'surfacing behindBy version drift). Optionally designate one source as the ' +
        'baseline to reframe cells as added/removed/modified/unchanged. Returns ' +
        'isError when a source id is not a live spec (frozen package/revision ids 404).',
      inputSchema: {
        sources: z
          .array(z.uuid())
          .length(2)
          .refine((s) => new Set(s).size === s.length, {
            message: 'the two sources must be distinct (a spec cannot be compared with itself)',
          })
          .describe('Exactly two distinct live spec UUIDs (project or master) to compare'),
        baseline: z
          .uuid()
          .optional()
          .describe('Optional: one of sources, to project a baseline lens over the matrix'),
      },
    },
    handleCompareSpecs
  );
}
