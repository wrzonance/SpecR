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
import type { GenerateBody, StyleRule, SpecTree } from '../ast/index.js';
import type { SectionNumberFormat } from '../lib/section-number.js';
import {
  getSpecTree,
  getTemplate,
  getTemplateByName,
  resolveSpecGenerationContext,
  resolveSpecHeaderFooterContext,
  pool,
} from '../db/index.js';
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

/** Resolve the generator-ready header/footer input for a spec's sole owning
 *  project (#304), or undefined when nothing applies — mirrors
 *  src/api/generate-header-footer.ts's `buildHeaderFooterOptions` inline
 *  rather than importing it (see `todayIsoDate`), so generate_docx renders
 *  in lockstep with POST /specs/:id/generate (ADR-044). Exported so a
 *  dedicated unit test can pin its no-mutation invariant (I5) the same way
 *  `buildHeaderFooterOptions`'s own suite does
 *  (src/api/generate-header-footer.test.ts) — `server.integration.test.ts`
 *  re-fetches fresh rows from Postgres on every call, so a mutation here
 *  would otherwise never surface as a failure.
 *
 *  Deliberately a SEPARATE DB round trip from `resolveSpecGenerationContext`
 *  below rather than folded into one combined lookup: `handlers.test.ts`
 *  pins this function's exact `(specId, pool)` call signature via dedicated
 *  mock-based tests (I2/I5/I9), so unifying the two calls would mean
 *  changing that test contract — a separate decision, not a side effect of
 *  this extraction. This reopens a narrow ownership-snapshot race window
 *  that unifying the two reads would close (ADR-079/#304 originally closed
 *  it for the REST path by unifying them there); accepted as a pre-existing
 *  tradeoff already present in this MCP handler before this change. */
export async function resolveHeaderFooterInput(
  specId: string
): Promise<HeaderFooterGenerationInput | undefined> {
  const context = await resolveSpecHeaderFooterContext(specId, pool);
  if (context === null) return undefined;
  const current: HeaderFooterFieldValues = { date: todayIsoDate(), ...context.fieldValues };
  return { composition: context.composition, current };
}

async function resolveGenerateOptions(
  specId: string,
  body: GenerateBody
): Promise<GenerateDocxOptions | undefined> {
  const specContext = await resolveSpecGenerationContext(specId, pool);
  const format = body.sectionNumberFormat ?? specContext.sectionNumberFormat ?? undefined;
  const headerFooter = await resolveHeaderFooterInput(specId);
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
  const { specId, templateId } = args;
  try {
    const result = await getSpecTree(specId);
    if (!result) {
      return toolErr(`Spec not found: id=${specId}`);
    }
    const resolution = await resolveStyleRulesForMcp(templateId);
    if (!resolution.found) {
      return toolErr(`template not found: id=${templateId ?? ''}`);
    }
    const options = await resolveGenerateOptions(specId, args);
    const buf = await generateDocx(result.tree, resolution.rules, options);
    return generateDocxResult(specId, result.tree, buf);
  } catch (err) {
    logger.error({ err }, 'mcp tool generate_docx failed');
    return toolErr('Internal error — DOCX generation failed');
  }
}
