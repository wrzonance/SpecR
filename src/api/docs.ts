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

export function registerDocsRoutes(app: Express): void {
  app.get('/docs', (_req: Request, res: Response) => {
    res.type('html').send(PAGE);
  });
  app.get('/docs/scalar.js', (_req: Request, res: Response) => {
    res
      .type('application/javascript')
      .sendFile(join(SCALAR_DIR, SCALAR_STANDALONE), { dotfiles: 'allow' }, (err: Error) => {
        if (!err || res.headersSent) return;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res
            .status(404)
            .type('text/plain')
            .send('Scalar bundle not found — run: pnpm vendor:scalar');
        } else {
          res.status(500).type('text/plain').send('failed to serve Scalar bundle');
        }
      });
  });
  app.get('/openapi.yaml', (_req: Request, res: Response) => {
    res.type('text/yaml').sendFile(OPENAPI_PATH, { dotfiles: 'allow' });
  });
}
