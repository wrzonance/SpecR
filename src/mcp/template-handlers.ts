import { z } from 'zod';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  createTemplateWithRules,
  updateTemplateMeta,
  deleteTemplate,
  bulkUpsertTemplateRules,
} from '../db/index.js';
import {
  CreateTemplateBodySchema,
  PatchTemplateBodySchema,
  UpsertStyleRulesBodySchema,
} from '../ast/index.js';
import { analyzeDocxStyles, deriveTemplate, assertDocxSafe, ParserError } from '../parser/index.js';
import { decodeBase64Payload } from '../lib/decode-base64.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes are exported so template-tools.ts advertises exactly the fields these handlers
// validate — the REST body schemas are the single source of truth, reused verbatim.
export const TemplateIdShape = {
  templateId: z.uuid().describe('Style template UUID (from list_templates)'),
};
const TemplateIdArgs = z.object(TemplateIdShape);

export const CreateTemplateShape = CreateTemplateBodySchema.shape;

// Path id + the REST PATCH body reused. Deliberately stricter than REST (consistent
// with update_spec): at least one mutable field must be present — an empty patch is a
// mistake worth rejecting for an agent rather than silently no-op'ing.
export const UpdateTemplateShape = {
  ...TemplateIdShape,
  ...PatchTemplateBodySchema.shape,
};
const UpdateTemplateArgs = z
  .object(UpdateTemplateShape)
  .refine((v) => v.name !== undefined || v.owner !== undefined, {
    message: 'at least one of name or owner is required',
  });

export const UpsertTemplateRulesShape = {
  ...TemplateIdShape,
  ...UpsertStyleRulesBodySchema.shape,
};
const UpsertTemplateRulesArgs = z.object(UpsertTemplateRulesShape);

// name + optional owner reused from the REST create body, plus the inline DOCX payload.
export const ImportTemplateShape = {
  ...CreateTemplateBodySchema.shape,
  contentBase64: z.string().describe('Base64-encoded .docx file to derive a style template from'),
};
const ImportTemplateArgs = z.object(ImportTemplateShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

export async function handleListTemplates(): Promise<ToolResult> {
  try {
    return ok(await listTemplates());
  } catch (err) {
    logger.error({ err }, 'mcp tool list_templates failed');
    return toolError('Internal error — list templates failed');
  }
}

export async function handleGetTemplate(args: unknown): Promise<ToolResult> {
  const parsed = TemplateIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid get_template input: templateId must be a UUID');
  try {
    const template = await getTemplate(parsed.data.templateId);
    if (!template) return toolError(`template not found: id=${parsed.data.templateId}`);
    return ok(template);
  } catch (err) {
    logger.error({ err }, 'mcp tool get_template failed');
    return toolError('Internal error — get template failed');
  }
}

export async function handleCreateTemplate(args: unknown): Promise<ToolResult> {
  const parsed = CreateTemplateBodySchema.safeParse(args);
  if (!parsed.success) return toolError(`invalid create_template input: ${issues(parsed.error)}`);
  const { name, owner, libraryId } = parsed.data;
  try {
    // #318 — libraryId scopes the template; omitted → NULL (built-in / global).
    return ok(await createTemplate(name, owner, libraryId));
  } catch (err) {
    if (getPgCode(err) === '23505') return toolError('template name already exists');
    // A libraryId for a non-existent library surfaces as an FK violation (23503).
    if (getPgCode(err) === '23503') return toolError('library not found');
    logger.error({ err }, 'mcp tool create_template failed');
    return toolError('Internal error — template create failed');
  }
}

export async function handleUpdateTemplate(args: unknown): Promise<ToolResult> {
  const parsed = UpdateTemplateArgs.safeParse(args);
  if (!parsed.success) return toolError(`invalid update_template input: ${issues(parsed.error)}`);
  const { templateId, name, owner } = parsed.data;
  const patch = {
    ...(name !== undefined ? { name } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
  try {
    const meta = await updateTemplateMeta(templateId, patch);
    if (!meta) return toolError(`template not found: id=${templateId}`);
    return ok(meta);
  } catch (err) {
    if (getPgCode(err) === '23505') return toolError('template name already exists');
    logger.error({ err }, 'mcp tool update_template failed');
    return toolError('Internal error — template update failed');
  }
}

export async function handleUpsertTemplateRules(args: unknown): Promise<ToolResult> {
  const parsed = UpsertTemplateRulesArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid upsert_template_rules input: ${issues(parsed.error)}`);
  }
  const { templateId, rules } = parsed.data;
  try {
    const template = await bulkUpsertTemplateRules(templateId, rules);
    if (!template) return toolError(`template not found: id=${templateId}`);
    return ok(template);
  } catch (err) {
    if (getPgCode(err) === '23514') return toolError('a rule violates a template check constraint');
    logger.error({ err }, 'mcp tool upsert_template_rules failed');
    return toolError('Internal error — upsert template rules failed');
  }
}

export async function handleDeleteTemplate(args: unknown): Promise<ToolResult> {
  const parsed = TemplateIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid delete_template input: templateId must be a UUID');
  const { templateId } = parsed.data;
  try {
    const result = await deleteTemplate(templateId);
    if (result.deleted) return ok({ deleted: true, templateId });
    if (result.reason === 'in_use') {
      // RESTRICT enforcement (#138): a referenced template cannot be hard-deleted.
      return toolError(
        `template in use by ${result.inUseBy ?? 0} spec(s) — reassign or clear those specs first`
      );
    }
    return toolError(`template not found: id=${templateId}`);
  } catch (err) {
    logger.error({ err }, 'mcp tool delete_template failed');
    return toolError('Internal error — delete template failed');
  }
}

export async function handleImportTemplate(args: unknown): Promise<ToolResult> {
  const parsed = ImportTemplateArgs.safeParse(args);
  if (!parsed.success) return toolError(`invalid import_template input: ${issues(parsed.error)}`);
  const { name, owner, contentBase64 } = parsed.data;
  const decoded = decodeBase64Payload(contentBase64);
  if ('error' in decoded) return toolError(decoded.error);
  try {
    await assertDocxSafe(decoded.buffer);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : 'invalid .docx file');
  }
  return deriveAndPersistTemplate(name, owner ?? null, decoded.buffer);
}

// Derive style rules from an analysed DOCX and persist them as a new template.
// Buffer is analysis-only and never stored (ADR-021).
async function deriveAndPersistTemplate(
  name: string,
  owner: string | null,
  buffer: Buffer
): Promise<ToolResult> {
  try {
    const analysis = await analyzeDocxStyles(buffer);
    const { rules, report } = deriveTemplate(analysis.classified, analysis.effectiveStyles);
    if (rules.length === 0) {
      return toolError('document contains no styleable paragraphs to derive a template from');
    }
    const template = await createTemplateWithRules(name, owner, rules);
    return ok({ template, report });
  } catch (err) {
    if (getPgCode(err) === '23505') return toolError('template name already exists');
    if (err instanceof ParserError) return toolError(err.message);
    logger.error({ err }, 'mcp tool import_template failed');
    return toolError('Internal error — template import failed');
  }
}
