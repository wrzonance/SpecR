// HTTP-boundary tests for the header/footer fixture route (#305, task
// 6/7). No real pipeline stages run here — HeaderFooterFixturePipeline is
// stubbed (mirrors routes/runs.test.ts's stubPipeline pattern) so these pin
// only this route layer's own contract: JSON body -> pipeline.startRun(),
// with a closed z.enum over the fixture catalog's own scenario ids.

import { type Server } from 'node:http';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEADER_FOOTER_SCENARIOS } from '../../fixtures/header-footer-scenarios.js';
import type {
  HeaderFooterFixturePipeline,
  StartHeaderFooterFixtureInput,
} from '../../run/header-footer-pipeline.js';
import { createHeaderFooterFixturesRouter } from './header-footer-fixtures.js';

function stubPipeline(
  startRun: (input: StartHeaderFooterFixtureInput) => string
): HeaderFooterFixturePipeline {
  return { startRun };
}

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

describe('createHeaderFooterFixturesRouter (HTTP boundary)', () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function mount(pipeline: HeaderFooterFixturePipeline): Promise<void> {
    app = express();
    app.use(express.json());
    app.use('/api/header-footer-fixtures', createHeaderFooterFixturesRouter(pipeline));
    return listen(app).then((result) => {
      server = result.server;
      baseUrl = result.baseUrl;
    });
  }

  describe('POST /api/header-footer-fixtures (start)', () => {
    it('starts a fixture run for a known scenarioId and returns 202 with the runId', async () => {
      const startRun = vi.fn((_input: StartHeaderFooterFixtureInput) => 'hf-run-1');
      await mount(stubPipeline(startRun));

      const response = await fetch(`${baseUrl}/api/header-footer-fixtures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'default' }),
      });
      const body = (await response.json()) as { success: boolean; data: { runId: string } };

      expect(response.status).toBe(202);
      expect(body).toEqual({ success: true, data: { runId: 'hf-run-1' } });
      expect(startRun).toHaveBeenCalledExactlyOnceWith({ scenarioId: 'default' });
    });

    it.each(HEADER_FOOTER_SCENARIOS.map((scenario) => scenario.id))(
      'accepts catalog scenarioId %s',
      async (scenarioId) => {
        await mount(stubPipeline(() => 'hf-run-1'));

        const response = await fetch(`${baseUrl}/api/header-footer-fixtures`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scenarioId }),
        });

        expect(response.status).toBe(202);
      }
    );

    it('answers 422 when scenarioId is missing', async () => {
      await mount(stubPipeline(() => 'hf-run-1'));

      const response = await fetch(`${baseUrl}/api/header-footer-fixtures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(422);
    });

    it('answers 422 for a scenarioId outside the fixture catalog', async () => {
      const startRun = vi.fn((_input: StartHeaderFooterFixtureInput) => 'hf-run-1');
      await mount(stubPipeline(startRun));

      const response = await fetch(`${baseUrl}/api/header-footer-fixtures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'not-a-real-scenario' }),
      });

      expect(response.status).toBe(422);
      expect(startRun).not.toHaveBeenCalled();
    });
  });
});
