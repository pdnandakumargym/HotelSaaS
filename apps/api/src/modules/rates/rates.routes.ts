import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant, type Tx } from '../../infrastructure/db/tenant.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError, NotFoundError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import { orgRoleHas } from '../rbac/permissions.js';
import { enqueueForChange, enqueueSync } from '../channels/sync.service.js';
import { applyBulkUpdate, getCalendar } from './calendar.service.js';
import { addDays, daysBetween, isIsoDate, todayIn } from './dates.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || !UUID.test(v)) throw new NotFoundError();
  return v;
}

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const isoDate = z.string().refine(isIsoDate, 'Use a date in YYYY-MM-DD format');

const ratePlanFields = {
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9_-]{1,20}$/, 'Use 1-20 letters, digits, - or _')),
  description: z.preprocess(blankToNull, z.string().trim().max(1000).nullable().optional()),
  mealPlan: z.preprocess(blankToNull, z.enum(['ROOM_ONLY', 'BREAKFAST', 'HALF_BOARD', 'FULL_BOARD', 'ALL_INCLUSIVE']).nullable().optional()),
  singleOccupancyDiscountPct: z.preprocess(blankToNull, z.number().int().min(0).max(90).nullable().optional()),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  sortOrder: z.number().int().min(0).max(10000),
};
const CreateRatePlanBody = registry.register(
  'CreateRatePlanRequest',
  z.object({ ...ratePlanFields, status: ratePlanFields.status.default('ACTIVE'), sortOrder: ratePlanFields.sortOrder.default(0) }).strict(),
);
const UpdateRatePlanBody = z.object(ratePlanFields).partial().strict();

const CalendarQuery = z.object({ from: isoDate.optional(), days: z.coerce.number().int().min(1).max(62).default(14) });

const money = z.number().min(0).max(10_000_000);
const BulkBody = registry.register(
  'CalendarBulkUpdateRequest',
  z
    .object({
      from: isoDate,
      to: isoDate,
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      roomTypeIds: z.array(z.uuid()).min(1).max(100),
      ratePlanIds: z.array(z.uuid()).max(100).optional(),
      availability: z
        .object({ available: z.number().int().min(0).max(9999).nullable().optional(), stopSell: z.boolean().optional() })
        .strict()
        .optional(),
      rates: z
        .object({
          price: money.nullable().optional(),
          priceSingle: money.nullable().optional(),
          minStay: z.number().int().min(0).max(31).nullable().optional(),
          maxStay: z.number().int().min(0).max(31).nullable().optional(),
          closed: z.boolean().optional(),
          closedOnArrival: z.boolean().optional(),
          closedOnDeparture: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((v) => v.to >= v.from, { message: 'End date must be on or after the start date', path: ['to'] })
    .refine((v) => daysBetween(v.from, v.to) <= 400, { message: 'At most 400 days per update', path: ['to'] })
    .refine((v) => v.rates?.minStay == null || v.rates?.maxStay == null || v.rates.maxStay === 0 || v.rates.minStay <= v.rates.maxStay, {
      message: 'Minimum stay must not exceed maximum stay',
      path: ['rates', 'minStay'],
    }),
);

for (const [method, path, summary] of [
  ['get', '/organizations/{orgId}/properties/{propertyId}/rate-plans', 'Rate plans of a property'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/rate-plans', 'Create a rate plan'],
  ['patch', '/organizations/{orgId}/properties/{propertyId}/rate-plans/{ratePlanId}', 'Update a rate plan'],
  ['delete', '/organizations/{orgId}/properties/{propertyId}/rate-plans/{ratePlanId}', 'Delete an unused rate plan'],
  ['get', '/organizations/{orgId}/properties/{propertyId}/calendar', 'Availability and rates per room type and date'],
  ['put', '/organizations/{orgId}/properties/{propertyId}/calendar', 'Bulk-update availability and/or rates (queues channel updates)'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Rates & inventory'], summary, responses: { 200: { description: 'OK' }, 404: { description: 'Not found or not a member' } } });
}

/** Mounted at /organizations/:orgId/properties/:propertyId. */
export function ratesRouter(deps: { db: Database; audit: AuditService }): Router {
  const { db, audit } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());
  const tenant = <T>(req: Request, fn: (tx: Tx) => Promise<T>) => withTenant(db, req.org!.organizationId, fn);
  const record = (req: Request, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>, tx: Tx) =>
    audit.record({ action, organizationId: req.org!.organizationId, actorUserId: req.auth!.user.id, entityType, entityId, metadata, ...requestMeta(req) }, tx);
  const loadProperty = async (tx: Tx, id: string) => {
    const p = await tx.property.findUnique({ where: { id }, select: { id: true, timezone: true } });
    if (!p) throw new NotFoundError('Property not found');
    return p;
  };

  // --- rate plans ---------------------------------------------------------------

  r.get('/rate-plans', requireOrgPermission('property.read'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const list = await tenant(req, async (tx) => {
      await loadProperty(tx, propertyId);
      return tx.ratePlan.findMany({ where: { propertyId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    });
    sendData(res, list);
  });

  r.post('/rate-plans', requireOrgPermission('rate.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const body = parseBody(CreateRatePlanBody, req);
    const created = await tenant(req, async (tx) => {
      await loadProperty(tx, propertyId);
      const p = await tx.ratePlan.create({ data: { ...body, organizationId: req.org!.organizationId, propertyId } });
      await record(req, 'rate_plan.created', 'rate_plan', p.id, { code: p.code }, tx);
      return p;
    });
    sendData(res, created, 201);
  });

  r.patch('/rate-plans/:ratePlanId', requireOrgPermission('rate.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const id = param(req, 'ratePlanId');
    const body = parseBody(UpdateRatePlanBody, req);
    const updated = await tenant(req, async (tx) => {
      const existing = await tx.ratePlan.findFirst({ where: { id, propertyId } });
      if (!existing) throw new NotFoundError('Rate plan not found');
      const p = await tx.ratePlan.update({ where: { id }, data: body });
      await record(req, 'rate_plan.updated', 'rate_plan', id, { fields: Object.keys(body) }, tx);
      // Derived-pricing offset changed: resend it to channels using price model 2.
      if (body.singleOccupancyDiscountPct !== undefined) {
        const maps = await tx.channelRateMapping.findMany({ where: { ratePlanId: id }, select: { roomMapping: { select: { roomTypeId: true, connection: { select: { id: true, status: true, priceModelId: true, property: { select: { timezone: true } } } } } } } });
        for (const m of maps) {
          const c = m.roomMapping.connection;
          if (c.status !== 'ACTIVE' || c.priceModelId !== 2) continue;
          const today = todayIn(c.property.timezone);
          await enqueueSync(tx, { organizationId: req.org!.organizationId, connectionId: c.id, kind: 'RATES_DERIVED', roomTypeId: m.roomMapping.roomTypeId, ratePlanId: id, dateFrom: today, dateTo: addDays(today, 1), requestedById: req.auth!.user.id });
        }
      }
      return p;
    });
    sendData(res, updated);
  });

  r.delete('/rate-plans/:ratePlanId', requireOrgPermission('rate.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const id = param(req, 'ratePlanId');
    await tenant(req, async (tx) => {
      const existing = await tx.ratePlan.findFirst({ where: { id, propertyId } });
      if (!existing) throw new NotFoundError('Rate plan not found');
      if ((await tx.channelRateMapping.count({ where: { ratePlanId: id } })) > 0) {
        throw new AppError(409, 'RATE_PLAN_MAPPED', 'This rate plan is mapped to a booking channel. Remove it from the channel mapping first, or set it to Inactive.');
      }
      await tx.rateDay.deleteMany({ where: { ratePlanId: id } });
      await tx.ratePlan.delete({ where: { id } });
      await record(req, 'rate_plan.deleted', 'rate_plan', id, { code: existing.code }, tx);
    });
    sendData(res, { status: 'deleted' });
  });

  // --- calendar -------------------------------------------------------------------

  r.get('/calendar', requireOrgPermission('property.read'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const q = parseQuery(CalendarQuery, req);
    const cal = await tenant(req, async (tx) => {
      const p = await loadProperty(tx, propertyId);
      return getCalendar(tx, propertyId, q.from ?? todayIn(p.timezone), q.days);
    });
    sendData(res, cal);
  });

  r.put('/calendar', requireOrgPermission('property.read'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const body = parseBody(BulkBody, req);
    const role = req.org!.role;
    if (body.availability && !orgRoleHas(role, 'inventory.write')) throw new AppError(403, 'FORBIDDEN', 'Your role cannot change availability.');
    if (body.rates && !orgRoleHas(role, 'rate.write')) throw new AppError(403, 'FORBIDDEN', 'Your role cannot change rates.');
    if (!body.availability && !body.rates) throw new AppError(400, 'NOTHING_TO_UPDATE', 'Choose availability and/or rate changes.');
    const orgId = req.org!.organizationId;
    const result = await tenant(req, async (tx) => {
      const p = await loadProperty(tx, propertyId);
      const today = todayIn(p.timezone);
      if (body.from < today) throw new AppError(400, 'PAST_DATE', 'Dates in the past cannot be changed.');
      if (body.to > addDays(today, 730)) throw new AppError(400, 'TOO_FAR', 'Dates can be set up to two years ahead.');
      const applied = await applyBulkUpdate(tx, orgId, propertyId, body);
      const queued = await enqueueForChange(tx, {
        organizationId: orgId,
        propertyId,
        roomTypeIds: applied.roomTypeIds,
        ratePlanIds: applied.ratePlanIds,
        availability: applied.availabilityChanged,
        rates: applied.ratesChanged,
        dateFrom: applied.dateFrom,
        dateTo: applied.dateTo,
        requestedById: req.auth!.user.id,
      });
      await record(
        req,
        'calendar.updated',
        'property',
        propertyId,
        { from: body.from, to: body.to, dates: applied.dates, roomTypes: applied.roomTypeIds.length, ratePlans: applied.ratePlanIds.length, availability: applied.availabilityChanged, rates: applied.ratesChanged, syncJobs: queued },
        tx,
      );
      return { dates: applied.dates, changed: applied.changed, syncJobsQueued: queued };
    });
    sendData(res, result);
  });

  return r;
}
