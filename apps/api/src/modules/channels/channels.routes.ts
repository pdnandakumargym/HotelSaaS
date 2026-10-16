import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant } from '../../infrastructure/db/tenant.js';
import { requireAuth, requirePlatformPermission } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import type { ChannelConnectionService } from './connection.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import { getSubscription } from '../subscriptions/plan-limits.js';
import { REFERENCE_KINDS, type ReferenceKind } from './channel-provider.js';
import type { IntegrationService } from './integration.service.js';

for (const [method, path, summary, tag] of [
  ['get', '/admin/integrations/zodomus', 'Zodomus configuration status and API health (no credentials)', 'Admin'],
  ['post', '/admin/integrations/zodomus/test', 'Test Connection: authenticated read-only call (GET /account)', 'Admin'],
  ['get', '/admin/integrations/zodomus/calls', 'Recent outbound calls (metadata only)', 'Admin'],
  ['get', '/admin/integrations/zodomus/reference/{kind}', 'Cached read-only reference data (account, channels, currencies, price_models)', 'Admin'],
  ['post', '/admin/integrations/zodomus/reference/{kind}/refresh', 'Fetch reference data from Zodomus and cache it (sanitized)', 'Admin'],
  ['get', '/organizations/{orgId}/channels', 'Channel availability for an organization (no fabricated connections)', 'Channels'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: [tag], summary, responses: { 200: { description: 'OK' }, 409: { description: 'Integration not configured' } } });
}

function kindParam(v: unknown): ReferenceKind {
  if (typeof v === 'string' && (REFERENCE_KINDS as readonly string[]).includes(v)) return v as ReferenceKind;
  throw new AppError(404, 'NOT_FOUND', 'Unknown reference data kind');
}

/** Mounted inside the admin router (which already requires a platform role and verified 2FA). */
export function adminIntegrationsRouter(integrations: IntegrationService): Router {
  const r = Router();
  r.use(requirePlatformPermission('admin.integration.read'));

  r.get('/zodomus', async (_req, res) => {
    sendData(res, { config: integrations.configStatus(), health: await integrations.health() });
  });

  r.get('/zodomus/calls', async (req, res) => {
    const { limit } = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req);
    sendData(res, await integrations.recentCalls(limit));
  });

  r.get('/zodomus/reference/:kind', async (req, res) => {
    sendData(res, await integrations.reference(kindParam(req.params['kind'])));
  });

  // Read-only provider calls, but they spend the platform's Zodomus quota and are audited.
  r.post('/zodomus/test', requirePlatformPermission('admin.integration.manage'), async (req, res) => {
    sendData(res, await integrations.testConnection(req.auth!.user, requestMeta(req)));
  });

  r.post('/zodomus/reference/:kind/refresh', requirePlatformPermission('admin.integration.manage'), async (req, res) => {
    sendData(res, await integrations.refreshReference(kindParam(req.params['kind']), req.auth!.user, requestMeta(req)));
  });

  return r;
}

const OWNER_STATE = {
  connected: 'available',
  degraded: 'available',
  failing: 'unavailable',
  untested: 'not_verified',
  disabled: 'not_configured',
  not_configured: 'not_configured',
} as const;

/**
 * Owner overview of channels: whether the platform's Zodomus connection is available, which channels it offers,
 * plan usage, and each property's real channel connections (none are shown unless they exist).
 */
export function orgChannelsRouter(deps: { db: Database; integrations: IntegrationService; connections: ChannelConnectionService }): Router {
  const { db, integrations, connections } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());

  r.get('/', requireOrgPermission('property.read'), async (req, res) => {
    const orgId = req.org!.organizationId;
    const [health, channels, sub, properties] = await Promise.all([
      integrations.health(),
      integrations.reference('channels'),
      withTenant(db, orgId, (tx) => getSubscription(tx, orgId)),
      withTenant(db, orgId, (tx) =>
        tx.property.findMany({
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            status: true,
            channelConnections: {
              where: { status: { not: 'DISCONNECTED' } },
              select: { id: true, channelId: true, channelName: true, channelPropertyId: true, status: true, environment: true, lastError: true, _count: { select: { roomMappings: true } } },
            },
          },
        }),
      ),
    ]);
    const inUse = properties.reduce((n, p) => n + p.channelConnections.length, 0);
    const cfg = integrations.configStatus();
    sendData(res, {
      provider: { displayName: cfg.displayName, environment: cfg.environment, state: OWNER_STATE[health.connection] },
      availableChannels: channels ? { items: channels.payload, itemCount: channels.itemCount, fetchedAt: channels.fetchedAt } : null,
      plan: { code: sub.plan.code, maxChannels: sub.plan.maxChannels, channelsInUse: inUse },
      properties: properties.map(({ channelConnections, ...p }) => ({
        ...p,
        connections: channelConnections.map(({ _count, ...c }) => ({ ...c, mappedRooms: _count.roomMappings })),
      })),
      mapping: { available: connections.channels().ready, channelOptions: connections.channels().channels },
    });
  });

  return r;
}

// ---------------------------------------------------------------------------
// Milestone 5: Booking.com connection wizard (per property)
// ---------------------------------------------------------------------------

const CreateConnectionBody = z
  .object({
    channelId: z.number().int().positive(),
    channelPropertyId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,40}$/, 'Use the property id exactly as shown by the channel (letters, digits, - or _)'),
    priceModelId: z.number().int().min(1).max(4),
  })
  .strict();
const MappingBody = z
  .object({
    rooms: z
      .array(
        z
          .object({
            channelRoomId: z.string().trim().min(1).max(40),
            roomTypeId: z.uuid(),
            rates: z.array(z.object({ channelRateId: z.string().trim().min(1).max(40), ratePlanId: z.uuid() }).strict()).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

for (const [method, path, summary] of [
  ['get', '/organizations/{orgId}/channel-options', 'Channels available through the channel manager'],
  ['get', '/organizations/{orgId}/properties/{propertyId}/channel-connections', 'Channel connections of a property'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections', 'Connect a property to a channel (POST /property-activation)'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/activate', 'Retry property activation'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/room-rates', 'Load channel rooms and rates (GET /room-rates)'],
  ['put', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/mapping', 'Save room/rate mapping and activate rooms'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/check', 'Check property status (POST /property-check)'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/sync', 'Queue a full availability and rate sync'],
  ['get', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/jobs', 'Recent sync jobs'],
  ['delete', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}', 'Disconnect (POST /property-cancellation)'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Channels'], summary, responses: { 200: { description: 'OK' }, 409: { description: 'Not configured or wrong state' } } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(v: unknown): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return v;
}

export function channelOptionsRouter(connections: ChannelConnectionService): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth());
  r.get('/', requireOrgPermission('property.read'), (_req, res) => {
    sendData(res, connections.channels());
  });
  return r;
}

/** Mounted at /organizations/:orgId/properties/:propertyId/channel-connections. */
export function connectionsRouter(deps: { connections: ChannelConnectionService }): Router {
  const { connections } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());

  const owned = async (req: Request) => {
    const orgId = req.org!.organizationId;
    const propertyId = uuidParam(req.params['propertyId']);
    const id = uuidParam(req.params['connectionId']);
    const c = await connections.get(orgId, id);
    if (c.propertyId !== propertyId) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    return { orgId, id };
  };

  r.get('/', requireOrgPermission('property.read'), async (req, res) => {
    sendData(res, await connections.list(req.org!.organizationId, uuidParam(req.params['propertyId'])));
  });

  r.post('/', requireOrgPermission('channel.manage'), async (req, res) => {
    const body = parseBody(CreateConnectionBody, req);
    sendData(res, await connections.create(req.org!.organizationId, uuidParam(req.params['propertyId']), body, req.auth!.user, requestMeta(req)), 201);
  });

  r.post('/:connectionId/activate', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.activate(orgId, id, req.auth!.user, requestMeta(req)));
  });

  r.post('/:connectionId/room-rates', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.refreshRoomRates(orgId, id, req.auth!.user, requestMeta(req)));
  });

  r.put('/:connectionId/mapping', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.saveMapping(orgId, id, parseBody(MappingBody, req), req.auth!.user, requestMeta(req)));
  });

  r.post('/:connectionId/check', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.check(orgId, id, req.auth!.user, requestMeta(req)));
  });

  r.post('/:connectionId/sync', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.fullSync(orgId, id, req.auth!.user, requestMeta(req)));
  });

  r.get('/:connectionId/jobs', requireOrgPermission('property.read'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.jobs(orgId, id));
  });

  r.delete('/:connectionId', requireOrgPermission('channel.manage'), async (req, res) => {
    const { orgId, id } = await owned(req);
    sendData(res, await connections.disconnect(orgId, id, req.auth!.user, requestMeta(req)));
  });

  return r;
}
