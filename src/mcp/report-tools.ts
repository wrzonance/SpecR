import { z } from 'zod';
import { handleCoordinationReport } from './handlers.js';
import { handleCompareSpecs } from './reporting-handler.js';
import { handleGetProjectKeynotes } from './keynotes-handler.js';
import type { ToolRegistrar } from './tool-registry.js';

/** Cross-cutting read-only report tools: project coordination (errors &
 *  omissions), cross-spec comparison (ADR-047), and keynote export (ADR-016).
 *  All `read` tier. */
export function registerReportTools(reg: ToolRegistrar): void {
  registerCoordinationTool(reg);
  registerCompareTool(reg);
  registerKeynotesTool(reg);
}

function registerKeynotesTool(reg: ToolRegistrar): void {
  reg.register(
    'get_project_keynotes',
    {
      description:
        'Project keynote table (ADR-016 D3), structured. Returns the project’s ' +
        'valid keynotes — a master keynote whose source library feeds the project ' +
        'and whose target section is present in the project TOC (ADR-016 D2) — as ' +
        'rows of { code, description, parentCode, targetSection, targetParagraphId, ' +
        'libraryId, id }, ordered by code, one row per code (higher-priority source ' +
        'wins a duplicate). parentCode preserves the keynote hierarchy. The REST ' +
        'route GET /projects/:id/keynotes renders these same rows as the flat ' +
        'tab-delimited file Revit imports. Requires a projectId (see list_projects).',
      inputSchema: {
        projectId: z.uuid().describe('Project UUID (from list_projects)'),
      },
    },
    handleGetProjectKeynotes
  );
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
        'live specs and returns a symmetric matrix — one row per aligned paragraph, ' +
        'one column per source, each cell the source’s verbatim text or absent. Every ' +
        'present cell traces to a real specId + paragraph UUID; nothing is synthesized. ' +
        'Alignment (see `alignment`): by resolved paragraph origin for clones of a ' +
        'shared master (project↔project / project↔master, surfacing behindBy drift), or ' +
        'by canonical structural address for independently-ingested specs of the same ' +
        'section. Set `include: "differences"` to return only non-identical rows (keeps ' +
        'the agent within a token budget); a `summary` rollup ({rows, aligned, identical, ' +
        'differing} + per-column {present, onlyIn}) is ALWAYS emitted over the full ' +
        'matrix, and `alignedBy` echoes the mode used. Optionally designate one source ' +
        'as the baseline to reframe cells as added/removed/modified/unchanged. Returns ' +
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
        alignment: z
          .enum(['origin', 'structure', 'auto'])
          .optional()
          .describe(
            'How to align rows. "origin": resolved paragraph origin (clones of a shared ' +
              'master). "structure": canonical structural address (independently-ingested ' +
              'specs of the same section). "auto" (default): origin when the sources share ' +
              'a cross-source origin, else structure. The mode used is echoed as alignedBy.'
          ),
        include: z
          .enum(['all', 'differences'])
          .optional()
          .describe(
            'Row scope. "all" (default): full matrix. "differences": only non-identical ' +
              'rows (modified / present-in-one). The summary still reports full-matrix totals.'
          ),
      },
    },
    handleCompareSpecs
  );
}
