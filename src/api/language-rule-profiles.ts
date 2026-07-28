import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  findLanguageRuleProfile,
  upsertLanguageRuleProfile,
  deleteLanguageRuleProfile,
  LanguageRuleValidationError,
  LanguageRuleScopeError,
} from '../db/index.js';
import type { LanguageRuleScopeKind } from '../db/index.js';
import { PutLanguageRulesBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';

// #411 / ADR-080 — REST CRUD for a scope's language-rule profile (library or
// project). Mirrors src/api/conventions.ts's parse/require/sendWriteError
// convention. Unlike conventions.ts, no pre-flight owner-existence check is
// needed here: findLanguageRuleProfile deliberately treats "no owner" and "no
// profile" as the same null (query-layer doc comment — the distinction only
// matters on write), and upsertLanguageRuleProfile's own assertOwnerExists
// already throws LanguageRuleScopeError for a missing owner, which
// sendWriteError maps to 404 below — a second existence check would be a
// redundant round trip to the DB for the same answer.

const UUID_SCHEMA = z.uuid();

interface ScopeMeta {
  readonly paramLabel: string;
  readonly responseIdField: 'libraryId' | 'projectId';
}

const SCOPE_META: Record<LanguageRuleScopeKind, ScopeMeta> = {
  library: { paramLabel: 'library', responseIdField: 'libraryId' },
  project: { paramLabel: 'project', responseIdField: 'projectId' },
};

// Parse the :id path param, replying 400 on a malformed UUID.
function parseScopeId(req: Request, res: Response, label: string): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: `invalid ${label} id` });
    return null;
  }
  return result.data;
}

// LanguageRuleValidationError (unsafe/oversized regex) -> 422. LanguageRuleScopeError
// (write targeted a library/project that does not exist) -> 404. Anything else is
// unexpected — log with context, respond without leaking it.
function sendWriteError(err: unknown, res: Response, logMsg: string): void {
  if (err instanceof LanguageRuleValidationError) {
    res.status(422).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof LanguageRuleScopeError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  logger.error({ err }, logMsg);
  res.status(500).json({ success: false, error: 'internal server error' });
}

async function getLanguageRules(
  req: Request,
  res: Response,
  kind: LanguageRuleScopeKind
): Promise<void> {
  const meta = SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  try {
    const profile = await findLanguageRuleProfile({ scope: kind, ownerId: id });
    if (!profile) {
      res.status(404).json({ success: false, error: 'no language-rule profile configured' });
      return;
    }
    res.status(200).json({ success: true, data: profile });
  } catch (err) {
    logger.error({ err }, `get ${kind} language rules failed`);
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

async function putLanguageRules(
  req: Request,
  res: Response,
  kind: LanguageRuleScopeKind
): Promise<void> {
  const meta = SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  // Malformed rules shape -> 400. Unsafe regex -> 422 (write boundary, below).
  const parsed = PutLanguageRulesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'malformed language-rules body' });
    return;
  }
  try {
    const profile = await upsertLanguageRuleProfile(
      { scope: kind, ownerId: id },
      parsed.data.rules
    );
    res.status(200).json({ success: true, data: profile });
  } catch (err) {
    sendWriteError(err, res, `put ${kind} language rules failed`);
  }
}

async function deleteLanguageRules(
  req: Request,
  res: Response,
  kind: LanguageRuleScopeKind
): Promise<void> {
  const meta = SCOPE_META[kind];
  const id = parseScopeId(req, res, meta.paramLabel);
  if (!id) return;
  try {
    const deleted = await deleteLanguageRuleProfile({ scope: kind, ownerId: id });
    if (!deleted) {
      res.status(404).json({ success: false, error: 'no language-rule profile configured' });
      return;
    }
    res.status(200).json({ success: true, data: { [meta.responseIdField]: id } });
  } catch (err) {
    logger.error({ err }, `delete ${kind} language rules failed`);
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getLibraryLanguageRulesHandler(req: Request, res: Response): Promise<void> {
  await getLanguageRules(req, res, 'library');
}

export async function putLibraryLanguageRulesHandler(req: Request, res: Response): Promise<void> {
  await putLanguageRules(req, res, 'library');
}

export async function deleteLibraryLanguageRulesHandler(
  req: Request,
  res: Response
): Promise<void> {
  await deleteLanguageRules(req, res, 'library');
}

export async function getProjectLanguageRulesHandler(req: Request, res: Response): Promise<void> {
  await getLanguageRules(req, res, 'project');
}

export async function putProjectLanguageRulesHandler(req: Request, res: Response): Promise<void> {
  await putLanguageRules(req, res, 'project');
}

export async function deleteProjectLanguageRulesHandler(
  req: Request,
  res: Response
): Promise<void> {
  await deleteLanguageRules(req, res, 'project');
}
