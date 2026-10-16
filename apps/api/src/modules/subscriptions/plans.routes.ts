import { Router } from 'express';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem } from '../../infrastructure/db/tenant.js';
import { requireAuth } from '../../middleware/auth.js';
import { registry } from '../../openapi/registry.js';
import { sendData } from '../../shared/http.js';

registry.registerPath({ method: 'get', path: '/api/v1/plans', tags: ['Plans'], summary: 'Active plans (for the billing page)', responses: { 200: { description: 'OK' } } });

export function plansRouter(db: Database): Router {
  const r = Router();
  r.get('/', requireAuth(), async (_req, res) => {
    const plans = await withSystem(db, (tx) =>
      tx.plan.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { code: true, name: true, maxProperties: true, maxUsers: true, maxChannels: true, priceMonthlyMinor: true, currency: true, trialDays: true },
      }),
    );
    sendData(res, plans);
  });
  return r;
}
