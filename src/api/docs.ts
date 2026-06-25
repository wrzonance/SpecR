import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { SCALAR_DIR, SCALAR_STANDALONE } from './docs-assets.js';

const OPENAPI_PATH = join(process.cwd(), 'openapi.yaml');

const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SpecR API Reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="/docs/scalar.js"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.yaml' })
    </script>
  </body>
</html>`;

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err;
  return typeof code === 'string' ? code : undefined;
}

async function sendStaticFile(
  res: Response,
  path: string,
  contentType: string,
  missingMessage: string,
  failureMessage: string
): Promise<void> {
  try {
    res.type(contentType).send(await readFile(path));
  } catch (err) {
    if (res.headersSent) return;
    if (errorCode(err) === 'ENOENT') {
      res.status(404).type('text/plain').send(missingMessage);
      return;
    }
    res.status(500).type('text/plain').send(failureMessage);
  }
}

export function registerDocsRoutes(app: Express): void {
  app.get('/docs', (_req: Request, res: Response) => {
    res.type('html').send(PAGE);
  });
  app.get('/docs/scalar.js', async (_req: Request, res: Response) => {
    await sendStaticFile(
      res,
      join(SCALAR_DIR, SCALAR_STANDALONE),
      'application/javascript',
      'Scalar bundle not found — run: pnpm vendor:scalar',
      'failed to serve Scalar bundle'
    );
  });
  app.get('/openapi.yaml', async (_req: Request, res: Response) => {
    await sendStaticFile(
      res,
      OPENAPI_PATH,
      'text/yaml',
      'OpenAPI document not found',
      'failed to serve OpenAPI document'
    );
  });
}
