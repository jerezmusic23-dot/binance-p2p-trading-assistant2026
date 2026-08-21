import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes.js';
import { CentralMarketStore } from './server/centralStore.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // JSON Body parsing
  app.use(express.json());

  // Mount API routes
  app.use('/api', apiRouter);

  // Initialize and start Central Market Store polling
  const centralStore = CentralMarketStore.getInstance();
  centralStore.start();

  // Vite middleware for development or static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Binance Assistant] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Binance Assistant] Fatal server startup error:', err);
});
