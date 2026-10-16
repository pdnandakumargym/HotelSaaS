import type { Logger } from 'pino';
import type { SyncJobKind } from '../../generated/prisma/enums.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant, type Tx } from '../../infrastructure/db/tenant.js';
import { addDays, eachDate, fromDbDate, maxDate, minDate, minorToDecimal, toDbDate, todayIn, toSegments } from '../rates/dates.js';
import { effectiveAvailability } from '../rates/calendar.service.js';
import type { CallOutcome, ChannelProvider, ChannelSyncProvider, ProviderCallResult } from './channel-provider.js';
import { ProductionWriteBlockedError } from './zodomus/zodomus.client.js';

const TRANSIENT: ReadonlySet<CallOutcome> = new Set(['RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);
const MAX_ATTEMPTS = 8;
const MAX_RANGE_DAYS = 400;
const STALE_LOCK_MS = 10 * 60_000;

export interface EnqueueTarget {
  organizationId: string;
  connectionId: string;
  kind: SyncJobKind;
  roomTypeId?: string | null;
  ratePlanId?: string | null;
  dateFrom: string;
  /** Exclusive. */
  dateTo: string;
  requestedById?: string | null;
}

/**
 * Adds a channel update to the outbox. A pending (not yet started) job for the same target is widened
 * instead of adding another one, so a burst of calendar edits becomes one set of calls.
 * Must run inside the caller's tenant transaction so the job commits together with the data change.
 */
export async function enqueueSync(tx: Tx, t: EnqueueTarget): Promise<void> {
  const existing = await tx.syncJob.findFirst({
    where: {
      connectionId: t.connectionId,
      kind: t.kind,
      roomTypeId: t.roomTypeId ?? null,
      ratePlanId: t.ratePlanId ?? null,
      status: 'PENDING',
      lockedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) {
    const from = minDate(fromDbDate(existing.dateFrom), t.dateFrom);
    let to = maxDate(fromDbDate(existing.dateTo), t.dateTo);
    if (addDays(from, MAX_RANGE_DAYS) < to) to = addDays(from, MAX_RANGE_DAYS);
    if (to <= from) to = addDays(from, 1);
    await tx.syncJob.update({ where: { id: existing.id }, data: { dateFrom: toDbDate(from), dateTo: toDbDate(to), nextAttemptAt: new Date() } });
    return;
  }
  await tx.syncJob.create({
    data: {
      organizationId: t.organizationId,
      connectionId: t.connectionId,
      kind: t.kind,
      roomTypeId: t.roomTypeId ?? null,
      ratePlanId: t.ratePlanId ?? null,
      dateFrom: toDbDate(t.dateFrom),
      dateTo: toDbDate(t.dateTo),
      requestedById: t.requestedById ?? null,
    },
  });
}

/**
 * After a calendar change, queue updates for every ACTIVE connection of the property that maps the
 * affected room types / rate plans. Runs inside the tenant transaction of the change.
 */
export async function enqueueForChange(
  tx: Tx,
  input: { organizationId: string; propertyId: string; roomTypeIds: string[]; ratePlanIds?: string[] | null; availability: boolean; rates: boolean; dateFrom: string; dateTo: string; requestedById?: string },
): Promise<number> {
  const connections = await tx.channelConnection.findMany({
    where: { propertyId: input.propertyId, status: 'ACTIVE' },
    select: { id: true, roomMappings: { select: { roomTypeId: true, rates: { select: { ratePlanId: true } } } } },
  });
  let queued = 0;
  for (const c of connections) {
    for (const rm of c.roomMappings) {
      if (!input.roomTypeIds.includes(rm.roomTypeId)) continue;
      if (input.availability) {
        await enqueueSync(tx, { organizationId: input.organizationId, connectionId: c.id, kind: 'AVAILABILITY', roomTypeId: rm.roomTypeId, dateFrom: input.dateFrom, dateTo: input.dateTo, requestedById: input.requestedById });
        queued++;
      }
      if (input.rates) {
        for (const rate of rm.rates) {
          if (input.ratePlanIds && !input.ratePlanIds.includes(rate.ratePlanId)) continue;
          await enqueueSync(tx, { organizationId: input.organizationId, connectionId: c.id, kind: 'RATES', roomTypeId: rm.roomTypeId, ratePlanId: rate.ratePlanId, dateFrom: input.dateFrom, dateTo: input.dateTo, requestedById: input.requestedById });
          queued++;
        }
      }
    }
  }
  return queued;
}

/** Queue availability + rates for every mapped room type / rate plan over the sync horizon (and derived offsets for model 2). */
export async function enqueueFullSync(tx: Tx, connectionId: string, horizonDays: number, requestedById?: string): Promise<number> {
  const c = await tx.channelConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { id: true, organizationId: true, priceModelId: true, property: { select: { timezone: true } }, roomMappings: { select: { roomTypeId: true, rates: { select: { ratePlanId: true, ratePlan: { select: { singleOccupancyDiscountPct: true } } } } } } },
  });
  const from = todayIn(c.property.timezone);
  const to = addDays(from, horizonDays);
  let queued = 0;
  for (const rm of c.roomMappings) {
    await enqueueSync(tx, { organizationId: c.organizationId, connectionId: c.id, kind: 'AVAILABILITY', roomTypeId: rm.roomTypeId, dateFrom: from, dateTo: to, requestedById });
    queued++;
    for (const rate of rm.rates) {
      if (c.priceModelId === 2 && rate.ratePlan.singleOccupancyDiscountPct) {
        await enqueueSync(tx, { organizationId: c.organizationId, connectionId: c.id, kind: 'RATES_DERIVED', roomTypeId: rm.roomTypeId, ratePlanId: rate.ratePlanId, dateFrom: from, dateTo: addDays(from, 1), requestedById });
        queued++;
      }
      await enqueueSync(tx, { organizationId: c.organizationId, connectionId: c.id, kind: 'RATES', roomTypeId: rm.roomTypeId, ratePlanId: rate.ratePlanId, dateFrom: from, dateTo: to, requestedById });
      queued++;
    }
  }
  return queued;
}

interface JobRow {
  id: string;
  organization_id: string;
}

type Call = () => Promise<ProviderCallResult>;

/**
 * Sends queued jobs to the channel manager. Each job re-reads the current calendar when it runs (so the
 * latest values are always sent), compresses equal consecutive days into ranges, and posts them.
 * Safe to run in several API instances: jobs are claimed with FOR UPDATE SKIP LOCKED, and a target that
 * is already running is not claimed again until it finishes.
 */
export class SyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly provider: ChannelProvider,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) => this.logger.error({ err: (err as Error).message }, 'sync worker run failed'));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Processes due jobs once. Returns the number of jobs handled. */
  async runOnce(limit = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await withSystem(this.db, async (tx) => {
        await tx.$executeRaw`UPDATE sync_jobs SET status = 'PENDING', locked_at = NULL WHERE status = 'RUNNING' AND locked_at < ${new Date(this.now() - STALE_LOCK_MS)}`;
        return tx.$queryRaw<JobRow[]>`
          UPDATE sync_jobs SET status = 'RUNNING', locked_at = now(), attempts = attempts + 1, updated_at = now()
          WHERE id IN (
            SELECT j.id FROM sync_jobs j
            WHERE j.status = 'PENDING' AND j.next_attempt_at <= ${new Date(this.now())}
              AND NOT EXISTS (
                SELECT 1 FROM sync_jobs r WHERE r.status = 'RUNNING' AND r.connection_id = j.connection_id AND r.kind = j.kind
                  AND r.room_type_id IS NOT DISTINCT FROM j.room_type_id AND r.rate_plan_id IS NOT DISTINCT FROM j.rate_plan_id)
            ORDER BY j.next_attempt_at, j.created_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
          RETURNING id, organization_id`;
      });
      for (const j of jobs) await this.process(j);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  private async process(row: JobRow): Promise<void> {
    let planned: { calls: Call[]; skipReason: string | null };
    try {
      planned = await withTenant(this.db, row.organization_id, (tx) => this.plan(tx, row.id));
    } catch (err) {
      await this.finish(row, 'FAILED', { error: `Could not prepare the update: ${(err as Error).message}`.slice(0, 300) });
      return;
    }
    const { calls, skipReason } = planned;
    if (skipReason) {
      await this.finish(row, 'CANCELLED', { error: skipReason });
      return;
    }
    let made = 0;
    for (const call of calls) {
      let r: ProviderCallResult;
      try {
        r = await call();
      } catch (err) {
        const message = err instanceof ProductionWriteBlockedError ? err.message : `Could not call the channel manager: ${(err as Error).message}`;
        await this.finish(row, 'FAILED', { error: message.slice(0, 300), callsMade: made });
        return;
      }
      made++;
      if (!r.ok) {
        const transient = TRANSIENT.has(r.outcome);
        await this.finish(row, transient ? 'RETRY' : 'FAILED', { error: (r.error?.message ?? r.outcome).slice(0, 300), providerCode: r.providerCode ?? null, callsMade: made });
        return;
      }
    }
    await this.finish(row, 'SUCCEEDED', { callsMade: made });
  }

  private async finish(row: JobRow, result: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'RETRY', info: { error?: string; providerCode?: number | null; callsMade?: number }): Promise<void> {
    await withTenant(this.db, row.organization_id, async (tx) => {
      const job = await tx.syncJob.findUniqueOrThrow({ where: { id: row.id }, select: { attempts: true, connectionId: true, kind: true } });
      const giveUp = result === 'RETRY' && job.attempts >= MAX_ATTEMPTS;
      const status = result === 'RETRY' ? (giveUp ? 'FAILED' : 'PENDING') : result;
      const backoff = Math.min(30_000 * 2 ** (job.attempts - 1), 3_600_000);
      await tx.syncJob.update({
        where: { id: row.id },
        data: {
          status,
          lockedAt: null,
          lastError: info.error ?? null,
          providerCode: info.providerCode ?? null,
          callsMade: { increment: info.callsMade ?? 0 },
          nextAttemptAt: status === 'PENDING' ? new Date(this.now() + backoff) : undefined,
          finishedAt: status === 'PENDING' ? null : new Date(this.now()),
        },
      });
      if (status === 'FAILED') this.logger.warn({ jobId: row.id, kind: job.kind, connectionId: job.connectionId, error: info.error }, 'channel sync job failed');
    });
  }

  /** Builds the provider calls for one job from the current data. */
  private async plan(tx: Tx, jobId: string): Promise<{ calls: Call[]; skipReason: string | null }> {
    const provider = this.provider as ChannelProvider & Partial<ChannelSyncProvider>;
    if (!provider.isReady() || !provider.pushAvailability || !provider.pushRates || !provider.pushDerivedRates) {
      return { calls: [], skipReason: 'The channel manager is not enabled or not configured on this platform.' };
    }
    const job = await tx.syncJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { connection: { include: { property: { select: { timezone: true, currency: true } } } } },
    });
    const c = job.connection;
    if (c.status !== 'ACTIVE') return { calls: [], skipReason: `Connection is ${c.status.toLowerCase()}, not active.` };
    const ref = { channelId: c.channelId, channelPropertyId: c.channelPropertyId };
    const ctx = { requestId: `sync:${job.id}` };
    // Never send past dates.
    const today = todayIn(c.property.timezone, new Date(this.now()));
    const from = maxDate(fromDbDate(job.dateFrom), today);
    const to = fromDbDate(job.dateTo);
    const roomMapping = job.roomTypeId ? await tx.channelRoomMapping.findUnique({ where: { connectionId_roomTypeId: { connectionId: c.id, roomTypeId: job.roomTypeId } }, include: { rates: true } }) : null;
    if (!roomMapping) return { calls: [], skipReason: 'The room type is no longer mapped to this channel.' };

    if (job.kind === 'AVAILABILITY') {
      if (to <= from) return { calls: [], skipReason: null };
      const dates = eachDate(from, to);
      const avail = await effectiveAvailability(tx, c.propertyId, roomMapping.roomTypeId, from, to);
      const segments = toSegments(dates, (d) => avail.get(d) ?? 0, (v) => String(v));
      return {
        calls: segments.map((s) => () => provider.pushAvailability!({ ...ref, channelRoomId: roomMapping.channelRoomId, dateFrom: s.dateFrom, dateTo: s.dateTo, available: s.value }, ctx)),
        skipReason: null,
      };
    }

    const rateMapping = roomMapping.rates.find((r) => r.ratePlanId === job.ratePlanId);
    if (!rateMapping) return { calls: [], skipReason: 'The rate plan is no longer mapped to this channel.' };

    if (job.kind === 'RATES_DERIVED') {
      const [roomType, ratePlan] = await Promise.all([
        tx.roomType.findUniqueOrThrow({ where: { id: roomMapping.roomTypeId }, select: { baseOccupancy: true } }),
        tx.ratePlan.findUniqueOrThrow({ where: { id: rateMapping.ratePlanId }, select: { singleOccupancyDiscountPct: true } }),
      ]);
      const base = rateMapping.maxPersons ? Math.min(roomType.baseOccupancy, rateMapping.maxPersons) : roomType.baseOccupancy;
      const pct = ratePlan.singleOccupancyDiscountPct;
      if (c.priceModelId !== 2 || !pct || base <= 1) return { calls: [], skipReason: 'No derived pricing offsets to send.' };
      return {
        calls: [() => provider.pushDerivedRates!({ ...ref, channelRoomId: roomMapping.channelRoomId, channelRateId: rateMapping.channelRateId, baseOccupancy: base, occupancy: [{ persons: 1, percentage: -pct }] }, ctx)],
        skipReason: null,
      };
    }

    // RATES
    if (to <= from) return { calls: [], skipReason: null };
    const [roomType, days] = await Promise.all([
      tx.roomType.findUniqueOrThrow({ where: { id: roomMapping.roomTypeId }, select: { maxOccupancy: true } }),
      tx.rateDay.findMany({ where: { roomTypeId: roomMapping.roomTypeId, ratePlanId: rateMapping.ratePlanId, date: { gte: toDbDate(from), lt: toDbDate(to) } } }),
    ]);
    const byDate = new Map(days.map((d) => [fromDbDate(d.date), d]));
    const currency = c.property.currency;
    const sendSingle = c.priceModelId === 1 && roomType.maxOccupancy > 1;
    const segments = toSegments(
      eachDate(from, to),
      (d) => {
        const r = byDate.get(d);
        // Dates without a price are never sent (Booking.com would otherwise get a zero or empty price).
        if (!r || r.priceMinor === null) return null;
        return {
          price: minorToDecimal(r.priceMinor, currency),
          priceSingle: sendSingle && r.priceSingleMinor !== null ? minorToDecimal(r.priceSingleMinor, currency) : undefined,
          restrictions: { closed: r.closed, minStay: r.minStay, maxStay: r.maxStay, closedOnArrival: r.closedOnArrival, closedOnDeparture: r.closedOnDeparture },
        };
      },
      (v) => JSON.stringify(v),
    );
    return {
      calls: segments.map(
        (s) => () =>
          provider.pushRates!(
            { ...ref, channelRoomId: roomMapping.channelRoomId, channelRateId: rateMapping.channelRateId, currency, dateFrom: s.dateFrom, dateTo: s.dateTo, price: s.value.price, priceSingle: s.value.priceSingle, restrictions: s.value.restrictions },
            ctx,
          ),
      ),
      skipReason: null,
    };
  }
}

/** Rooms were added, removed or taken out of service: the default availability changed for these room types. */
export async function enqueueAvailabilityResync(tx: Tx, organizationId: string, propertyId: string, roomTypeIds: string[], horizonDays = 365): Promise<number> {
  if (!roomTypeIds.length) return 0;
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: { timezone: true } });
  if (!property) return 0;
  const from = todayIn(property.timezone);
  return enqueueForChange(tx, { organizationId, propertyId, roomTypeIds, availability: true, rates: false, dateFrom: from, dateTo: addDays(from, horizonDays) });
}
