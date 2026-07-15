// HTTP route for starting header/footer fixture runs (#305, task 6/7).
//
// POST /api/header-footer-fixtures starts a new fixture run from a
// catalog-listed scenarioId: no multipart upload (unlike POST /api/runs) —
// the reference DOCX is built server-side from
// fixtures/header-footer-scenarios.ts's own catalog, so this route only
// validates a small JSON body and wires it straight onto
// run/header-footer-pipeline.ts's fire-and-forget startRun(). Mirrors
// routes/runs.ts's startRunHandler shape exactly; poll progress via the
// existing GET /api/runs/:runId (both pipelines write into the same
// RunStore, see header-footer-pipeline.ts's own docstring).

import { Router, type Request, type Response } from 'express';
import * as z from 'zod';
import { HEADER_FOOTER_SCENARIOS } from '../../fixtures/header-footer-scenarios.js';
import type { HeaderFooterFixturePipeline } from '../../run/header-footer-pipeline.js';

// Derived from the fixture catalog's own ids, not hand-duplicated — a
// scenario added to/removed from HEADER_FOOTER_SCENARIOS never needs a
// second edit here to stay in sync.
const SCENARIO_IDS = HEADER_FOOTER_SCENARIOS.map((scenario) => scenario.id);

const StartHeaderFooterFixtureBodySchema = z.object({
  scenarioId: z.enum(SCENARIO_IDS),
});

function startHeaderFooterFixtureHandler(pipeline: HeaderFooterFixturePipeline) {
  return (req: Request, res: Response): void => {
    const bodyResult = StartHeaderFooterFixtureBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(422).json({ success: false, error: 'invalid header/footer fixture request body' });
      return;
    }
    const runId = pipeline.startRun({ scenarioId: bodyResult.data.scenarioId });
    res.status(202).json({ success: true, data: { runId } });
  };
}

export function createHeaderFooterFixturesRouter(pipeline: HeaderFooterFixturePipeline): Router {
  const router = Router();
  router.post('/', startHeaderFooterFixtureHandler(pipeline));
  return router;
}
