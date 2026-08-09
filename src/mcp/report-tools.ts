import { z } from 'zod';
import { handleCoordinationReport } from './handlers.js';
import { handleCompareSpecs } from './reporting-handler.js';
import { handleGetProjectKeynotes } from './keynotes-handler.js';
import { handleGetReferenceGraph } from './reference-graph-handler.js';
import { handleTextBoxesReport } from './text-boxes-handler.js';
import type { ToolRegistrar } from './tool-registry.js';

/** Cross-cutting read-only report tools: project coordination (errors &
 *  omissions), cross-spec comparison (ADR-047), keynote export (ADR-016), and
 *  the project/library reference graph (#447). All `read` tier. */
export function registerReportTools(reg: ToolRegistrar): void {
  registerCoordinationTool(reg);
  registerCompareTool(reg);
  registerKeynotesTool(reg);
  registerReferenceGraphTool(reg);
  registerTextBoxesTool(reg);
}

function registerTextBoxesTool(reg: ToolRegistrar): void {
  reg.register(
    'text_boxes_report',
    {
      description:
        'List retained body-level text boxes in one spec or across a project (#409). ' +
        'Each row includes specId, specSection, the object paragraph UUID, floating and ' +
        'generation metadata, and ordered interiorText extracted from objectText children. ' +
        'Tables are excluded. The persisted ADR-072 model does not distinguish callouts ' +
        'from other text boxes, so no narrower subtype is guessed. Provide exactly one of ' +
        'specId (see get_spec) or projectId (see list_projects).',
      inputSchema: {
        specId: z.uuid().optional().describe('Spec UUID — text boxes in one spec'),
        projectId: z.uuid().optional().describe('Project UUID — text boxes across the project'),
      },
    },
    handleTextBoxesReport
  );
}

function registerReferenceGraphTool(reg: ToolRegistrar): void {
  reg.register(
    'get_reference_graph',
    {
      description:
        'One-call section-reference graph for a whole project or library (#447). ' +
        'Returns nodes (in-scope specs: specId, section, title, division, isUmbrella ' +
        'for a "{division} 00 00" section), edges (section references: sourceSpecId, ' +
        'targetSection, scope-resolved targetSpecId or null when dangling, citationCount), ' +
        'and umbrella annotations per division (umbrella present/absent + subordinate ' +
        'specs that never call it out). Set includeAnchors=true to add capped per-edge ' +
        'paragraph-anchor lists (see anchorCap in the result). Provide EXACTLY ONE of ' +
        'projectId (see list_projects) or libraryId (see list_libraries).',
      inputSchema: {
        projectId: z.uuid().optional().describe('Project UUID — graph for this project'),
        libraryId: z.uuid().optional().describe('Library UUID — graph for this library'),
        includeAnchors: z
          .boolean()
          .optional()
          .describe('Add capped per-edge paragraph anchor lists (default false)'),
      },
    },
    handleGetReferenceGraph
  );
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

// Hand-duplicated mirror of the frozen half of CompareSource (src/reporting/types.ts,
// #392, ADR-078) — the MCP inputSchema is a ZodRawShape (see ToolRegistrar), which
// cannot host CompareRequestSchema's cross-field superRefine, so this shape is kept
// in lockstep by test (report-tools.test.ts) rather than by import.
const FrozenCompareSourceShape = z.object({ revisionId: z.uuid(), specId: z.uuid() }).strict();

/** Canonical identity for distinctness, mirroring `sourceKey` in
 *  src/reporting/types.ts. Reference-equality `Set` fails to dedupe two
 *  structurally-identical frozen objects (`{revisionId, specId}` literals are
 *  never `===`); `live:<uuid>` vs. `frozen:<revisionId>:<specId>` also legally
 *  distinguishes a live source from a frozen source of the SAME underlying
 *  spec — that pair is a genuine, intentional comparison. */
function compareSourceKey(source: z.infer<typeof FrozenCompareSourceShape> | string): string {
  return typeof source === 'string'
    ? `live:${source}`
    : `frozen:${source.revisionId}:${source.specId}`;
}

const COMPARE_DESCRIPTION =
  'Grounded, deterministic cross-spec comparison matrix. Aligns exactly two ' +
  'sources and returns a symmetric matrix — one row per aligned paragraph, ' +
  'one column per source, each cell the source’s verbatim text or absent. Every ' +
  'present cell traces to a real specId + paragraph UUID; nothing is synthesized. ' +
  'Each entry in `sources` is either a live spec UUID (project or master) or a ' +
  'frozen source object { revisionId, specId } naming the frozen tree of that spec ' +
  'within one issued package revision (#392) — e.g. compare a live spec against a ' +
  'past issuance, or two past issuances of the same package against each other. ' +
  'Alignment (see `alignment`): by resolved paragraph origin for clones of a ' +
  'shared master (project↔project / project↔master, surfacing behindBy drift), or ' +
  'by canonical structural address for independently-ingested specs of the same ' +
  'section. Set `include: "differences"` to return only non-identical rows (keeps ' +
  'the agent within a token budget); a `summary` rollup ({rows, aligned, identical, ' +
  'differing} + per-column {present, onlyIn}) is ALWAYS emitted over the full ' +
  'matrix, and `alignedBy` echoes the mode used. Optionally designate one source ' +
  'as the baseline (matched against each source’s underlying specId, not literal ' +
  'array membership) to reframe cells as added/removed/modified/unchanged — if ' +
  '`baseline` matches more than one source (e.g. the same spec frozen at two ' +
  'different revisions) this is an AMBIGUOUS match: unlike the REST comparison ' +
  'endpoint, this tool does not reject it, it silently uses the first matching ' +
  'source in request order, so list your intended baseline source first when ' +
  'that overlap is possible. Returns isError when a live source id does not ' +
  'exist, or a frozen source’s (revisionId, specId) pair does not exist.';

function registerCompareTool(reg: ToolRegistrar): void {
  reg.register(
    'compare_specs',
    {
      description: COMPARE_DESCRIPTION,
      inputSchema: {
        sources: z
          .array(z.union([z.uuid(), FrozenCompareSourceShape]))
          .length(2)
          .refine((s) => new Set(s.map(compareSourceKey)).size === s.length, {
            message:
              'the two sources must be distinct (a spec cannot be compared with itself); ' +
              'two frozen sources of the same revisionId + specId also count as identical',
          })
          .describe(
            'Exactly two distinct sources to compare. Each is either a live spec UUID ' +
              '(project or master) or a frozen source object { revisionId, specId } naming ' +
              'the frozen tree of that spec within one issued package revision (#392). A ' +
              'live source and a frozen source of the SAME underlying spec are a legal, ' +
              'distinct pair — two structurally-identical frozen objects are not.'
          ),
        baseline: z
          .uuid()
          .optional()
          .describe(
            'Optional: the underlying specId of one of sources, to project a baseline ' +
              'lens over the matrix. See the tool description for the ambiguous-match rule.'
          ),
        alignment: z
          .enum(['origin', 'structure', 'auto'])
          .optional()
          .describe(
            'How to align rows. "origin": resolved paragraph origin (clones of a shared ' +
              'master). "structure": canonical structural address (independently-ingested ' +
              'specs of the same section). "auto" (default): origin when the sources share ' +
              'a cross-source origin; structure when they share none but are the same ' +
              'section; otherwise origin. The mode used is echoed as alignedBy.'
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
