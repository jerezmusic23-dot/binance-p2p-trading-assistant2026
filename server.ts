import express from 'express';
import path from 'node:path';
import { apiRouter } from './server/routes.js';
import { CentralMarketStore } from './server/centralStore.js';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // API must be registered before the SPA fallback.
  app.use('/api', apiRouter);

  const centralStore = CentralMarketStore.getInstance();
  centralStore.start();

  if (process.env.NODE_ENV !== 'production') {
    /*
     * Imported here, not at the top of the file.
     *
     * A top-level import becomes an unconditional require() in the bundle, so
     * production had to resolve vite even though this branch never runs there.
     * vite is a devDependency, so any deploy that prunes dev dependencies -
     * what `npm ci --omit=dev` and most Node buildpacks do by default - died
     * at startup with "Cannot find module 'vite'".
     */
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    app.use(express.static(distPath, { index: false }));

    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Binance Assistant] Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Binance Assistant] Fatal server startup error:', err);
  process.exit(1);
});
