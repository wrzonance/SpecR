import type { Router } from 'express';
import {
  getLibraryLanguageRulesHandler,
  putLibraryLanguageRulesHandler,
  deleteLibraryLanguageRulesHandler,
  getProjectLanguageRulesHandler,
  putProjectLanguageRulesHandler,
  deleteProjectLanguageRulesHandler,
} from './language-rule-profiles.js';
import { getLanguageFindingsHandler } from './language-rule-findings.js';

// #411 / ADR-080 — language-lint rule profile CRUD + findings report routes.
// Registered directly onto the shared `router` passed in (never a mounted
// Express sub-router) so every route still shows up in
// test-utils/contract/validate-response.ts's expressRouteManifest, which
// only walks a router's own `.stack` and does not recurse into nested
// routers mounted via `.use()`. This file exists purely to keep router.ts
// itself under its enforced 400-line budget — mirroring how other modules
// in this codebase split out when they hit the same ceiling.
export function registerLanguageRuleRoutes(router: Router): void {
  router.get('/libraries/:id/language-rules', getLibraryLanguageRulesHandler);
  router.put('/libraries/:id/language-rules', putLibraryLanguageRulesHandler);
  router.delete('/libraries/:id/language-rules', deleteLibraryLanguageRulesHandler);
  router.get('/projects/:id/language-rules', getProjectLanguageRulesHandler);
  router.put('/projects/:id/language-rules', putProjectLanguageRulesHandler);
  router.delete('/projects/:id/language-rules', deleteProjectLanguageRulesHandler);
  router.get('/projects/:id/language-findings', getLanguageFindingsHandler);
}
