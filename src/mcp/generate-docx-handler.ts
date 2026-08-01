// src/mcp/generate-docx-handler.ts
// Extracted from handlers.ts (file-size budget, CLAUDE.md max-lines=400).
// generate_docx's style-rule and section-number-format resolution mirror
// src/api/generate.ts's resolveStyleRules/loadSingleSpecGenerationContext —
// same underlying db/index.js calls, same fallback logic, re-derived rather
// than imported (mcp/ never imports api/, module-boundary rule). The local
// toolErr helper mirrors the pattern used by the other standalone handler
// files (coordination-handler.ts, submittal-register-handler.ts,
// numbering-profile-handler.ts, open-comments-handler.ts,
// parse-document-handler.ts) rather than importing handlers.ts's toolError
// and creating a handlers.ts <-> generate-docx-handler.ts import cycle.
import type { GenerateBody, StyleRule, SpecTree, IssuanceMode } from '../ast/index.js';
import type { SectionNumberFormat } from '../lib/section-number.js';
import {
  getSpecTree,
  getTemplate,
  getTemplateByName,
  resolveSpecGenerationContext,
  assertReadyForFinal,
  ReadinessBlockedError,
  pool,
} from '../db/index.js';
import type { HeaderFooterGenerationContext } from '../db/index.js';
import { generateDocx } from '../generator/index.js';
import type {
  GenerateDocxOptions,
  HeaderFooterGenerationInput,
  HeaderFooterFieldValues,
} from '../generator/index.js';
import { logger } from '../lib/logger.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

// Mirrors src/api/generate.ts's DEFAULT_TEMPLATE_NAME. Duplicated as a 1-line
// constant rather than imported across the mcp/<->api/ module boundary — see
// this file's header comment.
const DEFAULT_TEMPLATE_NAME = 'UFGS-Default';

type RulesResolution =
  | { readonly found: true; readonly rules: readonly StyleRule[] | undefined }
  | { readonly found: false };

/** Mirrors src/api/generate.ts's resolveStyleRules: an explicit templateId
 *  must resolve to a real template (found: false otherwise); with no
 *  templateId, the seeded default template applies (rules undefined when
 *  even the default is missing — an un-migrated DB degrades to unstyled
 *  output, never an error). */
async function resolveStyleRulesForMcp(templateId: string | undefined): Promise<RulesResolution> {
  if (templateId !== undefined) {
    const template = await getTemplate(templateId);
    return template ? { found: true, rules: template.rules } : { found: false };
  }
  const fallback = await getTemplateByName(DEFAULT_TEMPLATE_NAME);
  return { found: true, rules: fallback?.rules };
}

function generateOptionsFor(
  format: SectionNumberFormat | undefined
): { readonly sectionNumberFormat: SectionNumberFormat } | undefined {
  return format === undefined ? undefined : { sectionNumberFormat: format };
}

/** Today's date, formatted `YYYY-MM-DD` (#304) — mirrored, not imported,
 *  from src/api/generate-header-footer.ts's `todayIsoDate`: mcp/ never
 *  imports from api/ (module-boundary rule), and this is only a 2-call-site
 *  duplication, under DRY's 3+-repeat threshold. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Map an already-resolved header/footer context to the generator-ready
 *  input (#304), or undefined when nothing applies — mirrors
 *  src/api/generate-header-footer.ts's `buildHeaderFooterOptions` inline
 *  rather than importing it (see `todayIsoDate`), so generate_docx renders
 *  in lockstep with POST /specs/:id/generate (ADR-044).
 *
 *  Takes the context rather than fetching it (#567 review finding): its
 *  caller now reads the section-number format and the header/footer from
 *  ONE `resolveSpecGenerationContext` snapshot. Two independent ownership
 *  reads left a race window in which a project-membership change between
 *  them could pair Project A's numbering with Project B's branding — the
 *  window ADR-079/#304 closed for the REST path by unifying the same two
 *  reads there. Pure, so its no-mutation invariant (I5) is pinned directly
 *  by unit test, the way `buildHeaderFooterOptions`'s own suite does
 *  (src/api/generate-header-footer.test.ts); `server.integration.test.ts`
 *  re-fetches fresh rows from Postgres on every call, so a mutation here
 *  would otherwise never surface as a failure. */
export function toHeaderFooterInput(
  context: HeaderFooterGenerationContext | null
): HeaderFooterGenerationInput | undefined {
  if (context === null) return undefined;
  const current: HeaderFooterFieldValues = { date: todayIsoDate(), ...context.fieldValues };
  return { composition: context.composition, current };
}

export type McpReadinessOutcome =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly toolError: ToolError };

interface ReadinessCheckedEntry {
  readonly tree: SpecTree;
}

/** Mirrors src/api/readiness-guard.ts's `enforceReadinessGate`: runs the
 *  ADR-079 issuance-readiness gate via the same `assertReadyForFinal` call
 *  REST uses, and maps a block into the same two-key `{error, findings}`
 *  shape REST's 422 body carries — packaged as a `ToolError` instead of an
 *  Express response write, since generate_docx has no HTTP status to set.
 *  `mode` omitted (or `'draft'`) and a clean or explicitly overridden
 *  `'final'` all no-op at zero evaluation cost (INV-1/INV-2/INV-3) — this
 *  was previously reachable behavior REST already had that generate_docx's
 *  MCP tool lacked entirely (readiness_report's own description flagged the
 *  gap, #539). Synchronous — `assertReadyForFinal` never awaits anything.
 *  Any error other than `ReadinessBlockedError` is rethrown unchanged so
 *  `handleGenerateDocx`'s own catch-all still surfaces an unexpected
 *  failure as its existing generic isError, never silently absorbed here
 *  (INV-13). */
export function checkMcpReadinessGate(
  trees: readonly ReadinessCheckedEntry[],
  mode: IssuanceMode | undefined,
  overrideReadinessGate: boolean | undefined
): McpReadinessOutcome {
  try {
    assertReadyForFinal(trees, mode, overrideReadinessGate);
    return { blocked: false };
  } catch (err) {
    if (!(err instanceof ReadinessBlockedError)) throw err;
    return {
      blocked: true,
      toolError: toolErr(JSON.stringify({ error: err.message, findings: err.findings })),
    };
  }
}

async function resolveGenerateOptions(
  specId: string,
  body: GenerateBody
): Promise<GenerateDocxOptions | undefined> {
  // ONE ownership snapshot for both the section-number format and the
  // header/footer — see toHeaderFooterInput's note on the race a second
  // independent read would reopen.
  const specContext = await resolveSpecGenerationContext(specId, pool);
  const format = body.sectionNumberFormat ?? specContext.sectionNumberFormat ?? undefined;
  const headerFooter = toHeaderFooterInput(specContext.headerFooter);
  const baseOptions = generateOptionsFor(format);
  return headerFooter ? { ...baseOptions, headerFooter } : baseOptions;
}

function generateDocxResult(specId: string, tree: SpecTree, buf: Buffer): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            specId,
            section: tree.section,
            title: tree.title,
            sizeBytes: buf.byteLength,
            contentBase64: buf.toString('base64'),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleGenerateDocx(
  args: { specId: string } & GenerateBody
): Promise<ToolResult> {
  const { specId, templateId, mode, overrideReadinessGate } = args;
  try {
    const result = await getSpecTree(specId);
    if (!result) {
      return toolErr(`Spec not found: id=${specId}`);
    }
    const resolution = await resolveStyleRulesForMcp(templateId);
    if (!resolution.found) {
      return toolErr(`template not found: id=${templateId ?? ''}`);
    }
    // Gated before resolveGenerateOptions's header/footer + section-format
    // DB round trip (#567) — a blocked Final issuance skips work REST's own
    // loadSingleSpecGenerationContext still pays for, since here the gate
    // only needs the tree already in hand.
    const gateOutcome = checkMcpReadinessGate([{ tree: result.tree }], mode, overrideReadinessGate);
    if (gateOutcome.blocked) {
      return gateOutcome.toolError;
    }
    const options = await resolveGenerateOptions(specId, args);
    const buf = await generateDocx(result.tree, resolution.rules, options);
    return generateDocxResult(specId, result.tree, buf);
  } catch (err) {
    logger.error({ err }, 'mcp tool generate_docx failed');
    return toolErr('Internal error — DOCX generation failed');
  }
}
