import type { Request, Response } from 'express';
import { z } from 'zod';
import { GenerateBodySchema } from '../ast/index.js';
import type { StyleRule, SpecTree } from '../ast/index.js';
import type { SectionNumberFormat } from '../lib/section-number.js';
import { getSpecTree, getTemplate, getTemplateByName, findProjectById, pool } from '../db/index.js';
import type { ProjectTocEntry } from '../db/index.js';
import { generateDocx, generateManual } from '../generator/index.js';
import { logger } from '../lib/logger.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// When no templateId is given the seeded default applies, so an explicit
// default-template request and a bare request produce identical output.
// Missing default (un-migrated DB) degrades to unstyled output, never an error.
const DEFAULT_TEMPLATE_NAME = 'UFGS-Default';

// Exported for unit testing.
export function safeFilename(section: string, title: string): string {
  // '.' is allowed in the section part so '26 00 13.10' stays distinguishable
  // from a hypothetical '26 00 1310' in the suggested filename.
  const s = section.replace(/[^a-zA-Z0-9.-]/g, '-').replace(/-+/g, '-');
  const t = title
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return `${s}-${t}.docx`;
}

type RulesResolution =
  | { readonly found: true; readonly rules: readonly StyleRule[] | undefined }
  | { readonly found: false };

async function resolveStyleRules(templateId: string | undefined): Promise<RulesResolution> {
  if (templateId !== undefined) {
    const template = await getTemplate(templateId);
    return template ? { found: true, rules: template.rules } : { found: false };
  }
  const fallback = await getTemplateByName(DEFAULT_TEMPLATE_NAME);
  return { found: true, rules: fallback?.rules };
}

function generateOptions(
  format: SectionNumberFormat | undefined
): { readonly sectionNumberFormat: SectionNumberFormat } | undefined {
  return format === undefined ? undefined : { sectionNumberFormat: format };
}

export async function generateHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const bodyResult = GenerateBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid generate request body' });
    return;
  }
  try {
    const result = await getSpecTree(idResult.data);
    if (!result) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    const resolution = await resolveStyleRules(bodyResult.data.templateId);
    if (!resolution.found) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    const options = generateOptions(bodyResult.data.sectionNumberFormat);
    const buffer = await generateDocx(result.tree, resolution.rules, options);
    const filename = safeFilename(result.tree.section, result.tree.title);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'generate failed');
    res.status(500).json({ success: false, error: 'generation failed' });
  }
}

// Exported for unit testing.
export function manualFilename(projectName: string): string {
  const base =
    projectName
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'project';
  return `${base}-manual.docx`;
}

/** Fetch each TOC section's tree in position order; drop any that vanished
 *  (FK makes this unreachable in practice, handled defensively). */
async function collectSectionTrees(toc: readonly ProjectTocEntry[]): Promise<SpecTree[]> {
  const results = await Promise.all(toc.map((entry) => getSpecTree(entry.specId)));
  return results.flatMap((result) => (result ? [result.tree] : []));
}

export async function generateManualHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const bodyResult = GenerateBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid generate request body' });
    return;
  }
  try {
    const project = await findProjectById(idResult.data, pool);
    if (!project) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    if (project.toc.length === 0) {
      res.status(422).json({ success: false, error: 'project has no sections to assemble' });
      return;
    }
    const resolution = await resolveStyleRules(bodyResult.data.templateId);
    if (!resolution.found) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    const trees = await collectSectionTrees(project.toc);
    const options = generateOptions(bodyResult.data.sectionNumberFormat);
    const buffer = await generateManual(trees, resolution.rules, options);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${manualFilename(project.name)}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'manual generation failed');
    res.status(500).json({ success: false, error: 'generation failed' });
  }
}
