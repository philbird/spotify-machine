import express from 'express';
import path from 'node:path';
import { config } from '../config.js';
import { applySchedule } from '../scheduler/index.js';
import { authRouter } from './routes/auth.js';
import { changelogRouter } from './routes/changelog.js';
import { dashboardRouter } from './routes/dashboard.js';
import { playlistsRouter } from './routes/playlists.js';
import { settingsRouter } from './routes/settings.js';
import { syncRouter } from './routes/sync.js';

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.use('/api/auth', authRouter);
  app.use('/api/sync', syncRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/changelog', changelogRouter);
  app.use('/api/playlists', playlistsRouter);

  // Serve built UI in production. In dev the Vite server proxies /api here.
  const webDist = path.resolve('web/dist');
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api] error:', message);
    res.status(500).json({ error: message });
  });

  return app;
}

export function startServer(): void {
  const app = createServer();
  app.listen(config.port, () => {
    console.log(`[server] http://127.0.0.1:${config.port}`);
    applySchedule();
  });
}
