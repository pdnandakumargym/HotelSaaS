import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { sendData } from '../../shared/http.js';
import { parseQuery } from '../../shared/validate.js';
import { isIsoDate } from '../rates/dates.js';
import { toCsv, type ReportService } from './report.service.js';

for (const [path, summary] of [
  ['/organizations/{orgId}/reports/summary', 'Occupancy, revenue, ADR, RevPAR by day, room type and channel (stay dates)'],
  ['/organizations/{orgId}/reports/summary.csv', 'The same report as CSV'],
] as const) {
  registry.registerPath({ method: 'get', path: `/api/v1${path}`, tags: ['Reports'], summary, responses: { 200: { description: 'OK' } } });
}

const isoDate = z.string().refine(isIsoDate, 'Use a date in YYYY-MM-DD format');
const Query = z.object({ propertyId: z.uuid(), from: isoDate, to: isoDate, includeTest: z.enum(['true', 'false']).default('true') });

/** Mounted at /organizations/:orgId/reports. */
export function reportsRouter(reports: ReportService): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth());
  const query = (req: Parameters<typeof parseQuery>[1]) => {
    const q = parseQuery(Query, req);
    return { ...q, includeTest: q.includeTest === 'true' };
  };
  r.get('/summary', requireOrgPermission('booking.read'), async (req, res) => {
    sendData(res, await reports.summary(req.org!.organizationId, query(req)));
  });
  r.get('/summary.csv', requireOrgPermission('booking.read'), async (req, res) => {
    const q = query(req);
    const data = await reports.summary(req.org!.organizationId, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="staysync-report-${q.from}-to-${q.to}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(toCsv(data));
  });
  return r;
}
