import { Pool } from 'pg';
import { config } from '../lib/env.js';
import { SpecrError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export class DatabaseError extends SpecrError {}

export function createPool(): Pool {
  return new Pool({ connectionString: config.DATABASE_URL });
}

export async function pingDatabase(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    throw new DatabaseError('database ping failed', { cause: err });
  }
}

export const pool = createPool();

pool.on('error', (err: Error) => {
  logger.error({ err }, 'pg pool error');
});

export {
  findSpecById,
  updateSpec,
  createSpec,
  getSpecTree,
  persistParsedSpec,
} from './queries/specs.js';
export type {
  SpecSummary,
  UpdateSpecInput,
  CreateSpecInput,
  SpecTreeResult,
  SpecReference,
} from './queries/specs.js';
export { insertTree, getParagraphWithAncestors } from './queries/paragraphs.js';
export type { ParagraphRow, ParagraphWithAncestors } from './queries/paragraphs.js';
export { insertRefs } from './queries/refs.js';
export {
  createProject,
  findProjectById,
  addSpecToProject,
  removeSpecFromProject,
  getBrokenRefs,
} from './queries/projects.js';
export type {
  ProjectSummary,
  ProjectWithToc,
  ProjectTocEntry,
  BrokenRef,
  CreateProjectInput,
  AddSpecResult,
} from './queries/projects.js';
export { searchParagraphs, listSpecSections, lookupSpecSectionTitle } from './queries/search.js';
export type { ParagraphSearchResult, SpecSectionResult } from './queries/search.js';
export {
  getTemplate,
  getTemplateByName,
  listTemplates,
  createTemplate,
  createTemplateWithRules,
  upsertStyleRule,
  updateTemplateMeta,
  deleteTemplate,
  bulkUpsertTemplateRules,
} from './queries/templates.js';
export { STYLE_NODE_TYPES } from './queries/templates.js';
export type {
  StyleNodeType,
  StyleRule,
  Template,
  TemplateMeta,
  StyleProperties,
} from './queries/templates.js';
export {
  upsertMapping,
  deleteMapping,
  getMappingsBySpec,
  getMappingsByInstance,
  getMappingsByParagraph,
} from './queries/revit.js';
export type {
  RevitMapping,
  RevitMappingInput,
  RevitDirection,
  RevitTransformType,
} from './queries/revit.js';
