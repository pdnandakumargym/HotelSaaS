import type { Prisma } from '../../generated/prisma/client.js';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant } from '../../infrastructure/db/tenant.js';
import { AppError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { getSubscription } from '../subscriptions/plan-limits.js';
import type { ChannelProvider, ChannelRoom, ChannelSyncProvider, ProviderCallResult } from './channel-provider.js';
import { enqueueFullSync } from './sync.service.js';
import { ProductionWriteBlockedError } from './zodomus/zodomus.client.js';
import type { ProviderRegistry } from './provider-registry.js';

type Actor = { id: string };
type SyncCapable = ChannelProvider & ChannelSyncProvider;

export interface MappingInput {
  rooms: { channelRoomId: string; roomTypeId: string; rates: { channelRateId: string; ratePlanId: string }[] }[];
}

/** What the API returns about one provider call (no raw data, no credentials). */
function callSummary(r: ProviderCallResult) {
  return { ok: r.ok, outcome: r.outcome, httpStatus: r.httpStatus, providerCode: r.providerCode ?? null, providerMessage: r.providerMessage ?? null, error: r.error?.message ?? null };
}

function failureText(step: string, r: ProviderCallResult, providerName = 'Zodomus'): string {
  const detail = r.providerMessage && r.providerMessage !== 'OK' ? ` ${providerName}: ${r.providerMessage}` : '';
  return `${step} failed: ${r.error?.message ?? r.outcome}.${detail}`.slice(0, 300);
}

/**
 * Connects a property to a channel through the channel manager, following Zodomus' documented order:
 * property-activation → room-rates → (property-check) → rooms-activation → property-check → push one year
 * of availability and rates. Each step's provider call happens outside database transactions.
 */
export class ChannelConnectionService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly providers: ProviderRegistry,
    private readonly audit: AuditService,
  ) {}

  /** The connection's channel manager (Zodomus unless the connection names another one). */
  private sync(providerId = this.providers.primary.id): SyncCapable {
    const provider = this.providers.get(providerId);
    const p = provider as Partial<SyncCapable> | undefined;
    if (!provider || !p || !provider.isReady() || !p.activateProperty || !p.fetchRoomRates || !p.activateRooms || !p.checkProperty) {
      throw new AppError(409, 'INTEGRATION_NOT_CONFIGURED', 'The channel manager is not enabled on this platform yet. Please contact support.');
    }
    return provider as SyncCapable;
  }

  private static options(provider: ChannelProvider) {
    const p = provider as Partial<SyncCapable>;
    return { id: provider.id, displayName: provider.displayName, ready: provider.isReady(), environment: provider.configStatus().environment, channels: p.channels ? p.channels() : [] };
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProductionWriteBlockedError) throw new AppError(409, 'PRODUCTION_WRITES_DISABLED', err.message);
      throw err;
    }
  }

  /** Top-level fields describe the primary provider (Zodomus) as before; `providers` lists every channel manager. */
  channels() {
    const primary = ChannelConnectionService.options(this.providers.primary);
    return { ready: primary.ready, environment: primary.environment, channels: primary.channels, providers: this.providers.list().map((p) => ChannelConnectionService.options(p)) };
  }

  list(organizationId: string, propertyId: string) {
    return withTenant(this.db, organizationId, async (tx) => {
      const property = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true } });
      if (!property) throw new AppError(404, 'NOT_FOUND', 'Property not found');
      return tx.channelConnection.findMany({
        where: { propertyId },
        orderBy: { createdAt: 'asc' },
        include: { roomMappings: { include: { rates: true } } },
      });
    });
  }

  get(organizationId: string, connectionId: string) {
    return withTenant(this.db, organizationId, async (tx) => {
      const c = await tx.channelConnection.findUnique({ where: { id: connectionId }, include: { roomMappings: { include: { rates: true } } } });
      if (!c) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
      return c;
    });
  }

  async create(
    organizationId: string,
    propertyId: string,
    input: { channelId: number; channelPropertyId: string; priceModelId: number; provider?: string },
    actor: Actor,
    meta: RequestMeta,
  ) {
    const providerId = input.provider ?? this.providers.primary.id;
    const provider = this.sync(providerId);
    const channel = provider.channels().find((c) => c.channelId === input.channelId);
    if (!channel) throw new AppError(400, 'UNKNOWN_CHANNEL', 'This channel is not available.');
    if (!channel.priceModels.some((m) => m.id === input.priceModelId)) throw new AppError(400, 'UNSUPPORTED_PRICE_MODEL', `${channel.name} does not support this price model.`);
    const environment = provider.configStatus().environment;

    const connection = await withTenant(this.db, organizationId, async (tx) => {
      const property = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true, currency: true } });
      if (!property) throw new AppError(404, 'NOT_FOUND', 'Property not found');
      const [sub, inUse] = await Promise.all([getSubscription(tx, organizationId), tx.channelConnection.count({ where: { status: { not: 'DISCONNECTED' } } })]);
      if (inUse >= sub.plan.maxChannels) {
        throw new AppError(402, 'PLAN_LIMIT_REACHED', `Your ${sub.plan.name} plan allows ${sub.plan.maxChannels} channel connection(s). Upgrade to connect more.`, { limit: sub.plan.maxChannels });
      }
      const existing = await tx.channelConnection.findFirst({ where: { propertyId, provider: providerId, channelId: input.channelId } });
      if (existing && existing.status !== 'DISCONNECTED') throw new AppError(409, 'ALREADY_CONNECTED', `This property already has a ${channel.name} connection.`);
      const data = {
        environment,
        channelName: channel.name,
        channelPropertyId: input.channelPropertyId,
        priceModelId: input.priceModelId,
        currency: property.currency,
        status: 'DRAFT' as const,
        lastError: null,
        channelRooms: undefined,
        createdById: actor.id,
      };
      const c = existing
        ? await tx.channelConnection.update({ where: { id: existing.id }, data: { ...data, activatedAt: null, channelRoomsFetchedAt: null } })
        : await tx.channelConnection.create({ data: { ...data, organizationId, propertyId, provider: providerId, channelId: input.channelId } });
      await this.audit.record(
        { action: 'channel.connection.created', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: c.id, metadata: { provider: providerId, channel: channel.name, priceModelId: input.priceModelId, environment }, ...meta },
        tx,
      );
      return c;
    });
    return this.activate(organizationId, connection.id, actor, meta);
  }

  /** POST /property-activation (also used to retry a failed activation). */
  async activate(organizationId: string, connectionId: string, actor: Actor, meta: RequestMeta) {
    const c = await this.get(organizationId, connectionId);
    if (c.status === 'DISCONNECTED') throw new AppError(409, 'DISCONNECTED', 'This connection was disconnected.');
    const provider = this.sync(c.provider);
    const r = await this.guarded(() => provider.activateProperty({ channelId: c.channelId, channelPropertyId: c.channelPropertyId, priceModelId: c.priceModelId }, { requestId: meta.requestId, actorUserId: actor.id }));
    const updated = await withTenant(this.db, organizationId, async (tx) => {
      const u = await tx.channelConnection.update({
        where: { id: c.id },
        data: r.ok ? { status: c.status === 'ACTIVE' ? 'ACTIVE' : 'ACTIVATED', activatedAt: new Date(), lastError: null } : { lastError: failureText('Property activation', r, provider.displayName) },
      });
      await this.audit.record(
        { action: r.ok ? 'channel.property.activated' : 'channel.property.activation_failed', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: c.id, metadata: { outcome: r.outcome, providerCode: r.providerCode ?? null }, ...meta },
        tx,
      );
      return u;
    });
    if (r.ok) await this.refreshRoomRates(organizationId, c.id, actor, meta).catch(() => undefined);
    return { connection: await this.get(organizationId, updated.id), result: callSummary(r) };
  }

  /** GET /room-rates → cached list of the channel's rooms and rates used by the mapping screen. */
  async refreshRoomRates(organizationId: string, connectionId: string, actor: Actor, meta: RequestMeta) {
    const c = await this.get(organizationId, connectionId);
    if (c.status === 'DRAFT' || c.status === 'DISCONNECTED') throw new AppError(409, 'NOT_ACTIVATED', 'Activate the property first.');
    const provider = this.sync(c.provider);
    const r = await provider.fetchRoomRates({ channelId: c.channelId, channelPropertyId: c.channelPropertyId }, { requestId: meta.requestId, actorUserId: actor.id });
    if (r.ok && r.data) {
      await withTenant(this.db, organizationId, (tx) =>
        tx.channelConnection.update({ where: { id: c.id }, data: { channelRooms: r.data as unknown as Prisma.InputJsonValue, channelRoomsFetchedAt: new Date(), lastError: null } }),
      );
    } else {
      await withTenant(this.db, organizationId, (tx) => tx.channelConnection.update({ where: { id: c.id }, data: { lastError: failureText('Loading rooms and rates', r, provider.displayName) } }));
    }
    return { connection: await this.get(organizationId, c.id), result: callSummary(r) };
  }

  /**
   * Saves the room/rate mapping, then property-check → rooms-activation → property-check.
   * On success the connection becomes ACTIVE and one year of availability and rates is queued.
   */
  async saveMapping(organizationId: string, connectionId: string, input: MappingInput, actor: Actor, meta: RequestMeta) {
    const ctx = { requestId: meta.requestId, actorUserId: actor.id };
    const current = await this.get(organizationId, connectionId);
    const provider = this.sync(current.provider);
    const plan = await withTenant(this.db, organizationId, async (tx) => {
      const c = await tx.channelConnection.findUnique({ where: { id: connectionId } });
      if (!c) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
      if (c.status === 'DRAFT' || c.status === 'DISCONNECTED') throw new AppError(409, 'NOT_ACTIVATED', 'Activate the property first.');
      const channelRooms = (c.channelRooms ?? []) as unknown as ChannelRoom[];
      if (!channelRooms.length) throw new AppError(409, 'ROOMS_NOT_LOADED', 'Load the channel rooms and rates first.');
      if (!input.rooms.length) throw new AppError(400, 'MAPPING_EMPTY', 'Map at least one room.');

      const seenRoomTypes = new Set<string>();
      const seenChannelRooms = new Set<string>();
      const resolved = [];
      for (const m of input.rooms) {
        const cr = channelRooms.find((r) => r.id === m.channelRoomId);
        if (!cr) throw new AppError(400, 'UNKNOWN_CHANNEL_ROOM', `Channel room ${m.channelRoomId} is not in the loaded list. Reload rooms and rates.`);
        if (seenRoomTypes.has(m.roomTypeId)) throw new AppError(400, 'DUPLICATE_ROOM_TYPE', 'Each room type can be mapped to one channel room only.');
        if (seenChannelRooms.has(m.channelRoomId)) throw new AppError(400, 'DUPLICATE_CHANNEL_ROOM', 'Each channel room can be mapped once.');
        seenRoomTypes.add(m.roomTypeId);
        seenChannelRooms.add(m.channelRoomId);
        const roomType = await tx.roomType.findFirst({ where: { id: m.roomTypeId, propertyId: c.propertyId }, select: { id: true, name: true, _count: { select: { rooms: true } } } });
        if (!roomType) throw new AppError(400, 'UNKNOWN_ROOM_TYPE', 'A room type does not belong to this property.');
        if (roomType._count.rooms === 0) throw new AppError(400, 'NO_ROOMS', `Add rooms to "${roomType.name}" before connecting it.`);
        if (!m.rates.length) throw new AppError(400, 'NO_RATES', `Map at least one rate for "${cr.name}".`);
        const rates = [];
        const seenPlans = new Set<string>();
        for (const rm of m.rates) {
          const rate = cr.rates.find((x) => x.id === rm.channelRateId);
          if (!rate) throw new AppError(400, 'UNKNOWN_CHANNEL_RATE', `Rate ${rm.channelRateId} does not belong to channel room "${cr.name}".`);
          if (seenPlans.has(rm.ratePlanId)) throw new AppError(400, 'DUPLICATE_RATE_PLAN', 'A rate plan can be mapped once per room.');
          seenPlans.add(rm.ratePlanId);
          const ratePlan = await tx.ratePlan.findFirst({ where: { id: rm.ratePlanId, propertyId: c.propertyId }, select: { id: true } });
          if (!ratePlan) throw new AppError(400, 'UNKNOWN_RATE_PLAN', 'A rate plan does not belong to this property.');
          rates.push({ ratePlanId: ratePlan.id, channelRateId: rate.id, channelRateName: rate.name, maxPersons: rate.maxPersons });
        }
        resolved.push({ roomTypeId: roomType.id, quantity: roomType._count.rooms, channelRoomId: cr.id, channelRoomName: cr.name, rates });
      }

      // Replace the mapping atomically.
      await tx.channelRoomMapping.deleteMany({ where: { connectionId: c.id } });
      for (const r of resolved) {
        await tx.channelRoomMapping.create({
          data: {
            organizationId,
            connectionId: c.id,
            propertyId: c.propertyId,
            roomTypeId: r.roomTypeId,
            channelRoomId: r.channelRoomId,
            channelRoomName: r.channelRoomName,
            rates: { create: r.rates.map((x) => ({ organizationId, propertyId: c.propertyId, ...x })) },
          },
        });
      }
      await this.audit.record(
        { action: 'channel.mapping.saved', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: c.id, metadata: { rooms: resolved.length, rates: resolved.reduce((n, r) => n + r.rates.length, 0) }, ...meta },
        tx,
      );
      return { c, resolved };
    });

    const ref = { channelId: plan.c.channelId, channelPropertyId: plan.c.channelPropertyId };
    const steps: { step: string; result: ReturnType<typeof callSummary> }[] = [];
    const run = async (step: string, fn: () => Promise<ProviderCallResult>) => {
      const r = await this.guarded(fn);
      steps.push({ step, result: callSummary(r) });
      return r;
    };
    let failed: string | null = null;
    // Step 1: property-check. In Zodomus test mode it moves the property to the state where rooms can be
    // activated; before activation it may legitimately report "not ready", so it does not stop the flow.
    await run('property-check', () => provider.checkProperty(ref, ctx));
    const act = await run('rooms-activation', () =>
      provider.activateRooms({ ...ref, rooms: plan.resolved.map((r) => ({ channelRoomId: r.channelRoomId, name: r.channelRoomName, quantity: r.quantity, channelRateIds: r.rates.map((x) => x.channelRateId) })) }, ctx),
    );
    if (!act.ok) failed = failureText('Room activation', act, provider.displayName);
    let check2: ProviderCallResult | null = null;
    if (!failed) check2 = await run('property-check', () => provider.checkProperty(ref, ctx));
    // Rooms activated but the property not confirmed yet (e.g. Booking.com still has to accept Zodomus):
    // keep ACTIVATED and let "Check status" finish the connection later.
    const pending = !failed && check2 !== null && !check2.ok;

    const queued = await withTenant(this.db, organizationId, async (tx) => {
      await tx.channelConnection.update({
        where: { id: plan.c.id },
        data: failed
          ? { status: 'ERROR', lastError: failed }
          : pending
            ? {
                status: 'ACTIVATED',
                roomsActivatedAt: new Date(),
                lastCheckAt: new Date(),
                lastCheckMessage: (check2?.providerMessage ?? check2?.outcome ?? '').slice(0, 300),
                lastError: `Rooms activated. The property is not confirmed yet${check2?.providerMessage ? ` (${provider.displayName}: ${check2.providerMessage})` : ''}. Use "Check status" again later.`.slice(0, 300),
              }
            : { status: 'ACTIVE', roomsActivatedAt: new Date(), lastError: null, lastCheckAt: new Date(), lastCheckMessage: check2?.providerMessage ?? null },
      });
      await this.audit.record(
        {
          action: failed ? 'channel.rooms.activation_failed' : pending ? 'channel.rooms.activated_pending' : 'channel.rooms.activated',
          organizationId,
          actorUserId: actor.id,
          entityType: 'channel_connection',
          entityId: plan.c.id,
          metadata: { steps: steps.map((s) => `${s.step}:${s.result.outcome}`) },
          ...meta,
        },
        tx,
      );
      return failed || pending ? 0 : enqueueFullSync(tx, plan.c.id, this.config.sync.horizonDays, actor.id);
    });
    return { connection: await this.get(organizationId, plan.c.id), steps, syncJobsQueued: queued };
  }

  async check(organizationId: string, connectionId: string, actor: Actor, meta: RequestMeta) {
    const c = await this.get(organizationId, connectionId);
    if (c.status === 'DRAFT' || c.status === 'DISCONNECTED') throw new AppError(409, 'NOT_ACTIVATED', 'Activate the property first.');
    const provider = this.sync(c.provider);
    const r = await this.guarded(() => provider.checkProperty({ channelId: c.channelId, channelPropertyId: c.channelPropertyId }, { requestId: meta.requestId, actorUserId: actor.id }));
    // A successful check after rooms were activated completes the connection and starts the first full sync.
    const promote = r.ok && c.status !== 'ACTIVE' && c.roomsActivatedAt !== null && c.roomMappings.length > 0;
    const syncJobsQueued = await withTenant(this.db, organizationId, async (tx) => {
      await tx.channelConnection.update({
        where: { id: c.id },
        data: {
          lastCheckAt: new Date(),
          lastCheckMessage: (r.providerMessage ?? r.error?.message ?? r.outcome).slice(0, 300),
          ...(promote ? { status: 'ACTIVE' as const, lastError: null } : {}),
        },
      });
      if (!promote) return 0;
      await this.audit.record({ action: 'channel.rooms.activated', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: c.id, metadata: { via: 'property-check' }, ...meta }, tx);
      return enqueueFullSync(tx, c.id, this.config.sync.horizonDays, actor.id);
    });
    return { connection: await this.get(organizationId, c.id), result: callSummary(r), syncJobsQueued };
  }

  async fullSync(organizationId: string, connectionId: string, actor: Actor, meta: RequestMeta) {
    return withTenant(this.db, organizationId, async (tx) => {
      const c = await tx.channelConnection.findUnique({ where: { id: connectionId } });
      if (!c) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
      if (c.status !== 'ACTIVE') throw new AppError(409, 'NOT_ACTIVE', 'Finish the room and rate mapping first.');
      const queued = await enqueueFullSync(tx, c.id, this.config.sync.horizonDays, actor.id);
      await this.audit.record({ action: 'channel.sync.requested', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: c.id, metadata: { jobs: queued }, ...meta }, tx);
      return { syncJobsQueued: queued };
    });
  }

  /** POST /property-cancellation, then stop syncing. Pending jobs are cancelled. */
  async disconnect(organizationId: string, connectionId: string, actor: Actor, meta: RequestMeta) {
    const c = await this.get(organizationId, connectionId);
    if (c.status === 'DISCONNECTED') return { connection: c, result: null };
    let summary: ReturnType<typeof callSummary> | null = null;
    if (c.status !== 'DRAFT') {
      const provider = this.sync(c.provider);
      const r = await this.guarded(() => provider.deactivateProperty({ channelId: c.channelId, channelPropertyId: c.channelPropertyId }, { requestId: meta.requestId, actorUserId: actor.id }));
      summary = callSummary(r);
      if (!r.ok) throw new AppError(502, 'DISCONNECT_FAILED', failureText('Disconnect', r, provider.displayName), summary);
    }
    await withTenant(this.db, organizationId, async (tx) => {
      await tx.channelConnection.update({ where: { id: c.id }, data: { status: 'DISCONNECTED', lastError: null } });
      await tx.syncJob.updateMany({ where: { connectionId: c.id, status: 'PENDING' }, data: { status: 'CANCELLED', finishedAt: new Date(), lastError: 'Connection disconnected' } });
      await this.audit.record({ action: 'channel.connection.disconnected', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: c.id, ...meta }, tx);
    });
    return { connection: await this.get(organizationId, c.id), result: summary };
  }

  jobs(organizationId: string, connectionId: string, limit = 50) {
    return withTenant(this.db, organizationId, async (tx) => {
      const c = await tx.channelConnection.findUnique({ where: { id: connectionId }, select: { id: true } });
      if (!c) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
      return tx.syncJob.findMany({ where: { connectionId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) });
    });
  }
}
