import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseQuery } from '../../shared/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import type { ProviderRegistry } from '../channels/provider-registry.js';
import type { ChannelConnectionService } from '../channels/connection.service.js';
import { ProductionWriteBlockedError } from '../channels/zodomus/zodomus.client.js';

for (const [method, path, summary] of [
  ['get', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/promotions', 'Booking.com promotions (GET /promotions, active=1|0)'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/channel-connections/{connectionId}/promotions/{promotionId}/{action}', 'Activate or deactivate a promotion'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Promotions'], summary, responses: { 200: { description: 'OK' }, 409: { description: 'Not active / not configured' } } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (v: unknown) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return v;
};

/** Mounted at /organizations/:orgId/properties/:propertyId/channel-connections/:connectionId/promotions. */
export function promotionsRouter(deps: { providers: ProviderRegistry; connections: ChannelConnectionService; audit: AuditService }): Router {
  const { providers, connections, audit } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());

  const active = async (req: Request) => {
    const orgId = req.org!.organizationId;
    const c = await connections.get(orgId, uuidParam(req.params['connectionId']));
    if (c.propertyId !== uuidParam(req.params['propertyId'])) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    const provider = providers.get(c.provider);
    if (!provider?.isReady() || !provider.promotions || !provider.setPromotionActive) {
      throw new AppError(409, provider?.isReady() ? 'NOT_SUPPORTED' : 'INTEGRATION_NOT_READY', provider?.isReady() ? `Promotions are not available through ${provider.displayName}.` : 'The channel manager is not enabled on this platform.');
    }
    if (c.status !== 'ACTIVE') throw new AppError(409, 'CONNECTION_NOT_ACTIVE', 'Promotions are available once the connection is active.');
    return { orgId, c, provider, ref: { channelId: c.channelId, channelPropertyId: c.channelPropertyId } };
  };

  r.get('/', requireOrgPermission('property.read'), async (req, res) => {
    const { active: a } = parseQuery(z.object({ active: z.enum(['1', '0']).default('1') }), req);
    const { ref, provider } = await active(req);
    const result = await provider.promotions!({ ...ref, active: a === '1' }, { requestId: req.requestId, actorUserId: req.auth!.user.id });
    if (!result.ok) throw new AppError(502, 'PROVIDER_ERROR', result.error?.message ?? 'Could not load promotions.', undefined, true);
    sendData(res, result.data ?? []);
  });

  r.post('/:promotionId/:action', requireOrgPermission('channel.manage'), async (req, res) => {
    const promotionId = req.params['promotionId'];
    const action = req.params['action'];
    if (typeof promotionId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(promotionId) || (action !== 'activate' && action !== 'deactivate')) throw new AppError(404, 'NOT_FOUND', 'Not found');
    const { orgId, c, ref, provider } = await active(req);
    let result;
    try {
      result = await provider.setPromotionActive!({ ...ref, promotionId, active: action === 'activate' }, { requestId: req.requestId, actorUserId: req.auth!.user.id });
    } catch (err) {
      if (err instanceof ProductionWriteBlockedError) throw new AppError(409, 'PRODUCTION_WRITES_DISABLED', err.message);
      throw err;
    }
    await audit.record({ action: `promotion.${action}d`, organizationId: orgId, actorUserId: req.auth!.user.id, entityType: 'channel_connection', entityId: c.id, metadata: { promotionId, ok: result.ok, providerCode: result.providerCode ?? null }, ...requestMeta(req) });
    if (!result.ok) throw new AppError(502, 'PROVIDER_ERROR', result.error?.message ?? 'The channel rejected the change.', undefined, true);
    sendData(res, { promotionId, active: action === 'activate' });
  });
  return r;
}
