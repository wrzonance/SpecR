import { z } from 'zod';
import {
  getTemplate,
  setSpecStyleSource,
  clearSpecStyleSource,
  getNumberingProfile,
  setSpecNumberingProfile,
  clearSpecNumberingProfile,
} from '../db/index.js';
import { SetStyleSourceBodySchema, SetSpecNumberingProfileBodySchema } from '../ast/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// specId-only shape, shared by the two clear tools.
export const AssignmentSpecIdShape = {
  specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
};
const SpecIdArgs = z.object(AssignmentSpecIdShape);

export const AssignStyleSourceShape = {
  ...AssignmentSpecIdShape,
  ...SetStyleSourceBodySchema.shape,
};
const AssignStyleSourceArgs = z.object(AssignStyleSourceShape);

export async function handleAssignStyleSource(args: unknown): Promise<ToolResult> {
  const parsed = AssignStyleSourceArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid assign_style_source input: specId and templateId must be UUIDs');
  }
  const { specId, templateId } = parsed.data;
  try {
    // Pre-check template existence: pg 23503 is ambiguous, so never let the FK error
    // decide — a missing template here is a clean not-found (mirrors the REST route).
    const template = await getTemplate(templateId);
    if (!template) return toolError(`template not found: id=${templateId}`);
    const outcome = await setSpecStyleSource(specId, templateId);
    if (outcome === 'spec-not-found') return toolError(`spec not found: id=${specId}`);
    if (outcome === 'template-not-found') {
      // Race: template deleted between the pre-check and the UPDATE (#366); the
      // EXISTS predicate matched zero rows, so surface it as not-found, not a scope error.
      return toolError(`template not found: id=${templateId}`);
    }
    if (outcome === 'library-mismatch') {
      return toolError('style template belongs to a different library than the spec');
    }
    return ok({ templateId, templateName: template.name });
  } catch (err) {
    // Backstop for the same race in its ultra-narrow window: EXISTS (statement
    // snapshot) still sees the template but the RI FK trigger finds it gone → 23503.
    // The common race is handled by 'template-not-found' above (#366).
    if (getPgCode(err) === '23503') return toolError(`template not found: id=${templateId}`);
    logger.error({ err }, 'mcp tool assign_style_source failed');
    return toolError('Internal error — style source assign failed');
  }
}

export async function handleClearStyleSource(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid clear_style_source input: specId must be a UUID');
  try {
    const cleared = await clearSpecStyleSource(parsed.data.specId);
    if (!cleared) return toolError(`spec not found: id=${parsed.data.specId}`);
    return ok({ styleSource: null }); // idempotent: clearing an already-null association still succeeds
  } catch (err) {
    logger.error({ err }, 'mcp tool clear_style_source failed');
    return toolError('Internal error — style source clear failed');
  }
}

export const AssignNumberingProfileShape = {
  ...AssignmentSpecIdShape,
  ...SetSpecNumberingProfileBodySchema.shape,
};
const AssignNumberingProfileArgs = z.object(AssignNumberingProfileShape);

export async function handleAssignNumberingProfile(args: unknown): Promise<ToolResult> {
  const parsed = AssignNumberingProfileArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid assign_numbering_profile input: specId and profileId must be UUIDs');
  }
  const { specId, profileId } = parsed.data;
  try {
    const profile = await getNumberingProfile(profileId);
    if (!profile) return toolError(`numbering profile not found: id=${profileId}`);
    const outcome = await setSpecNumberingProfile(specId, profileId);
    if (outcome === 'spec-not-found') return toolError(`spec not found: id=${specId}`);
    if (outcome === 'profile-not-found') {
      // Race: profile deleted between the pre-check and the UPDATE (#366); the
      // EXISTS predicate matched zero rows, so surface it as not-found, not a scope error.
      return toolError(`numbering profile not found: id=${profileId}`);
    }
    if (outcome === 'library-mismatch') {
      return toolError('numbering profile belongs to a different library than the spec');
    }
    return ok({ profileId, name: profile.name });
  } catch (err) {
    // Backstop for the same race in its ultra-narrow window: EXISTS (statement
    // snapshot) still sees the profile but the RI FK trigger finds it gone → 23503.
    // The common race is handled by 'profile-not-found' above (#366) — mirrors the
    // assign_style_source backstop so both tools honour the concurrent-delete 404.
    if (getPgCode(err) === '23503')
      return toolError(`numbering profile not found: id=${profileId}`);
    logger.error({ err }, 'mcp tool assign_numbering_profile failed');
    return toolError('Internal error — numbering profile assign failed');
  }
}

export async function handleClearNumberingProfile(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid clear_numbering_profile input: specId must be a UUID');
  }
  try {
    const cleared = await clearSpecNumberingProfile(parsed.data.specId);
    if (!cleared) return toolError(`spec not found: id=${parsed.data.specId}`);
    return ok({ cleared: true }); // REST returns 204; the tool confirms the clear
  } catch (err) {
    logger.error({ err }, 'mcp tool clear_numbering_profile failed');
    return toolError('Internal error — numbering profile clear failed');
  }
}
