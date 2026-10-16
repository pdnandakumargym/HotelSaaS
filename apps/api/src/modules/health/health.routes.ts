import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';
import { sendData } from '../../shared/http.js';
import type { HealthChecker } from './health.service.js';

export function healthRouter(config: AppConfig, checker: HealthChecker, version: string): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, {
      status: 'ok' as const,
      service: `${config.appName} API`,
      version,
      environment: config.nodeEnv,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', async (_req, res) => {
    const database = await checker.checkDatabase();
    const ready = database.status === 'up';
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, { status: ready ? 'ready' : 'not_ready', checks: { database }, timestamp: new Date().toISOString() }, ready ? 200 : 503);
  });

  return router;
}
