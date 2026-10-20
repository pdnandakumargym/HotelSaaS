import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ReservationStatus } from '../../generated/prisma/enums.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant } from '../../infrastructure/db/tenant.js';
import { decryptString, deriveKey, encryptString } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { ProviderRegistry } from '../channels/provider-registry.js';
import type { CallContext, ChannelProvider, ChannelReservationProvider, ParsedReservation, ProviderCallResult, ReservationState } from '../channels/channel-provider.js';
import { enqueueForChange } from '../channels/sync.service.js';
import { autoResolve, checkOverbooking, raiseDiscrepancy } from '../discrepancies/discrepancy.service.js';
import { addDays, currencyDigits, daysBetween, fromDbDate, maxDate, minDate, toDbDate, todayIn } from '../rates/dates.js';

/** Encrypted guest record. Only this structure is ever decrypted for people with booking.guest_pii.read. */
export interface GuestDetails {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  countryCode: string | null;
  customerRemarks: string | null;
  reservationRemarks: string | null;
  rooms: { channelRoomId: string | null; guestName: string | null; remarks: string | null }[];
}

export interface PollResult {
  connectionId: string;
  ok: boolean;
  queued: number;
  stored: number;
  skipped: number;
  failed: number;
  summary: { ok: boolean; stored: number } | null;
  error: string | null;
}

type Source = 'QUEUE' | 'SUMMARY' | 'TEST';
type Provider = ChannelProvider & Partial<ChannelReservationProvider>;
type ConnectionRow = { id: string; organizationId: string; propertyId: string; provider: string; environment: string; channelId: number; channelName: string; channelPropertyId: string; status: string; summaryImportedAt: Date | null; reservationsPollFailures: number; reservationsPolledAt: Date | null; reservationsPollError: string | null };

const MAX_PAYLOAD_CHARS = 64 * 1024;
const POLL_FAILURES_BEFORE_ALERT = 3;
const STATE_TO_STATUS: Record<ReservationState, ReservationStatus> = { NEW: 'CONFIRMED', MODIFIED: 'MODIFIED', CANCELLED: 'CANCELLED' };

/** Booking total; when the channel sends 0 or nothing at booking level, the sum of the room totals (sandbox sends "0"). */
export function bookingTotal(reservationTotal: number | null, roomTotals: (number | null)[]): number | null {
  const known = roomTotals.filter((t): t is number => t !== null);
  const sum = known.length ? known.reduce((a, b) => a + b, 0) : null;
  if (reservationTotal !== null && reservationTotal > 0) return reservationTotal;
  return sum !== null && sum > 0 ? sum : reservationTotal;
}

/** Decimal string → minor units, exact (no float rounding). */
export function decimalToMinor(amount: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const m = /^(\d{1,10})(?:\.(\d{1,4}))?$/.exec(amount);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(4, '0');
  const whole = Number(m[1]) * 10 ** digits;
  const fracMinor = Math.round(Number(frac.slice(0, 4)) / 10 ** (4 - digits));
  const v = whole + fracMinor;
  return Number.isSafeInteger(v) && v <= 2_000_000_000 ? v : null;
}

/**
 * Reservations from channels (Booking.com through Zodomus):
 * - polls the reservation queue of every active connection and retrieves each new/modified/cancelled booking once;
 * - imports bookings made before the connection (reservations-summary) once per connection;
 * - stores guest data encrypted, never logs it, never requests card data;
 * - deducts booked rooms from availability and queues availability updates for every connected channel;
 * - opens discrepancies for overbookings, unmapped rooms, incomplete data and failed retrievals.
 */
export class ReservationService {
  private readonly key: Buffer;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  /** Serialises polls of the same connection inside this process (background poller vs. "Fetch now"). */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly counters = { polls: 0, bookingsStored: 0, lastPollAt: null as string | null, lastError: null as string | null };

  /** Counters since start (for worker heartbeats; no tenant data). */
  stats() {
    return { ...this.counters };
  }

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly providers: ProviderRegistry,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.key = deriveKey(config.auth.dataEncryptionKey, 'guest-pii-encryption');
  }

  // --- background polling ------------------------------------------------------------------------

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAll().catch((err: unknown) => this.logger.error({ err: (err as Error).message }, 'reservation poll failed'));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  private purgeTimer: NodeJS.Timeout | null = null;

  /** Runs the guest-data retention purge now and then every 24 hours (when GUEST_DATA_RETENTION_DAYS > 0). */
  startRetention(): void {
    if (this.purgeTimer || this.config.sync.guestDataRetentionDays <= 0) return;
    const run = () => void this.purgeGuestData().catch((err: unknown) => this.logger.error({ err: (err as Error).message }, 'guest data purge failed'));
    run();
    this.purgeTimer = setInterval(run, 24 * 3_600_000);
    this.purgeTimer.unref();
  }

  /**
   * Erases guest personal data (encrypted guest details and payload copy) of stays that ended more than
   * GUEST_DATA_RETENTION_DAYS ago. Dates, rooms, totals and status stay for reports. Returns the number erased.
   */
  async purgeGuestData(days = this.config.sync.guestDataRetentionDays): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = new Date(this.now() - days * 86_400_000);
    const n = await withSystem(this.db, async (tx) => {
      const r = await tx.reservation.updateMany({
        where: { checkOut: { lt: cutoff }, OR: [{ guestEnc: { not: null } }, { payloadEnc: { not: null } }] },
        data: { guestEnc: null, payloadEnc: null },
      });
      if (r.count) await this.audit.record({ action: 'reservation.guest_data_purged', actorType: 'system', metadata: { count: r.count, retentionDays: days } }, tx);
      return r.count;
    });
    if (n) this.logger.info({ count: n, retentionDays: days }, 'guest personal data erased after retention period');
    return n;
  }

  private static ready(p: Provider | undefined): p is Provider & ChannelReservationProvider {
    return !!p && p.isReady() && !!p.reservationQueue && !!p.fetchReservation && !!p.reservationsSummary;
  }

  /** The connection's channel manager (Zodomus, Beds24). */
  private providerOf(c: { provider: string }): Provider | undefined {
    return this.providers.get(c.provider);
  }

  /** Environment of a provider's connections ("sandbox"/"production" for Zodomus; Beds24 accounts are live). */
  private static environmentOf(p: Provider): string {
    return p.configStatus().environment;
  }

  /** Polls every ACTIVE connection once (sequentially, to stay within the providers' rate limits). */
  async pollAll(): Promise<PollResult[]> {
    const ready = this.providers.list().filter((p) => ReservationService.ready(p));
    if (this.polling || !ready.length) return [];
    this.polling = true;
    try {
      const conns = await withSystem(this.db, (tx) =>
        tx.channelConnection.findMany({
          where: { status: 'ACTIVE', OR: ready.map((p) => ({ provider: p.id, environment: ReservationService.environmentOf(p) })) },
          select: { id: true, organizationId: true },
          orderBy: { reservationsPolledAt: { sort: 'asc', nulls: 'first' } },
        }),
      );
      const out: PollResult[] = [];
      for (const c of conns) {
        try {
          out.push(await this.pollConnection(c.organizationId, c.id, { requestId: `poll:${c.id}` }));
        } catch (err) {
          // One broken connection must not stop the others.
          this.counters.lastError = (err as Error).message.slice(0, 200);
          this.logger.error({ connectionId: c.id, err: (err as Error).message }, 'reservation poll of a connection failed');
        }
      }
      this.counters.polls++;
      this.counters.bookingsStored += out.reduce((n, r) => n + r.stored, 0);
      this.counters.lastPollAt = new Date(this.now()).toISOString();
      return out;
    } finally {
      this.polling = false;
    }
  }

  private async loadConnection(organizationId: string, connectionId: string): Promise<ConnectionRow> {
    const c = await withTenant(this.db, organizationId, (tx) =>
      tx.channelConnection.findUnique({
        where: { id: connectionId },
        select: { id: true, organizationId: true, propertyId: true, provider: true, environment: true, channelId: true, channelName: true, channelPropertyId: true, status: true, summaryImportedAt: true, reservationsPollFailures: true, reservationsPolledAt: true, reservationsPollError: true },
      }),
    );
    if (!c) throw new AppError(404, 'NOT_FOUND', 'Connection not found');
    return c;
  }

  private requireActive(c: ConnectionRow): Provider & ChannelReservationProvider {
    const p = this.providerOf(c);
    if (!ReservationService.ready(p)) throw new AppError(409, 'INTEGRATION_NOT_READY', 'The channel manager is not enabled or not configured on this platform.');
    if (c.status !== 'ACTIVE') throw new AppError(409, 'CONNECTION_NOT_ACTIVE', 'Reservations can be fetched once the connection is active (rooms mapped and confirmed).');
    const env = ReservationService.environmentOf(p);
    if (c.environment !== env) throw new AppError(409, 'ENVIRONMENT_MISMATCH', `This connection was made in the ${c.environment} environment; the platform now uses ${env}.`);
    return p;
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  /** Reads the reservation queue of one connection and stores every listed booking. */
  pollConnection(organizationId: string, connectionId: string, ctx: CallContext = {}): Promise<PollResult> {
    return this.locked(connectionId, () => this.pollConnectionNow(organizationId, connectionId, ctx));
  }

  private async pollConnectionNow(organizationId: string, connectionId: string, ctx: CallContext): Promise<PollResult> {
    const c = await this.loadConnection(organizationId, connectionId);
    const provider = this.requireActive(c);
    const ref = { channelId: c.channelId, channelPropertyId: c.channelPropertyId };
    const result: PollResult = { connectionId, ok: false, queued: 0, stored: 0, skipped: 0, failed: 0, summary: null, error: null };

    if (!c.summaryImportedAt) {
      const s = await this.importSummaryFor(c, ctx).catch((err: unknown) => ({ ok: false, stored: 0, error: (err as Error).message }));
      result.summary = { ok: s.ok, stored: s.stored };
    }

    // `since` ≈ last successful poll; after failed polls it reaches back over them (at most 30 days).
    // Zodomus ignores it (it has a real queue); Beds24 lists bookings changed since then.
    const since = c.reservationsPolledAt
      ? new Date(Math.max(c.reservationsPolledAt.getTime() - (c.reservationsPollError ? c.reservationsPollFailures * this.config.sync.reservationPollMs : 0), this.now() - 30 * 86_400_000))
      : null;
    const q = await provider.reservationQueue({ ...ref, since }, ctx);
    if (!q.ok || !q.data) {
      result.error = q.error?.message ?? 'Could not read the reservation queue.';
      await this.recordPollFailure(c, result.error, q);
      return result;
    }
    // The queue may list several changes of one booking; the latest (last listed) describes its current state.
    const latest = new Map<string, (typeof q.data)[number]>();
    const listedAsNew = new Set(q.data.filter((i) => i.state === 'NEW').map((i) => i.channelReservationId));
    for (const item of q.data) {
      latest.delete(item.channelReservationId);
      latest.set(item.channelReservationId, item);
    }
    result.queued = latest.size;
    for (const item of latest.values()) {
      const existing = await withTenant(this.db, organizationId, (tx) =>
        tx.reservation.findUnique({ where: { connectionId_channelReservationId: { connectionId, channelReservationId: item.channelReservationId } }, select: { status: true, channelChangedAt: true } }),
      );
      // Already stored this exact change (the queue may list it again until it expires there).
      if (existing && item.changedAt !== null && existing.channelChangedAt === item.changedAt && (!item.state || STATE_TO_STATUS[item.state] === existing.status || (item.state === 'NEW' && existing.status !== 'CANCELLED'))) {
        result.skipped++;
        continue;
      }
      const r = await provider.fetchReservation({ ...ref, channelReservationId: item.channelReservationId }, ctx);
      const parsed = r.ok ? (r.data?.find((x) => x.channelReservationId === item.channelReservationId) ?? (r.data?.length === 1 ? r.data[0] : undefined)) : undefined;
      if (!parsed) {
        result.failed++;
        await withTenant(this.db, organizationId, (tx) =>
          raiseDiscrepancy(tx, {
            organizationId,
            propertyId: c.propertyId,
            connectionId,
            kind: 'RESERVATION_FETCH_FAILED',
            severity: 'high',
            message: `Booking ${item.channelReservationId} is in the ${c.channelName} reservation queue but could not be retrieved: ${r.ok ? 'no reservation data was returned' : (r.error?.message ?? r.outcome)}`.slice(0, 300),
            details: { channelReservationId: item.channelReservationId, queueStatus: item.rawStatus, outcome: r.outcome, providerCode: r.providerCode ?? null },
            dedupeKey: `fetch:${connectionId}:${item.channelReservationId}`,
          }),
        );
        continue;
      }
      await this.ingest(c, parsed, { source: 'QUEUE', state: item.state, changedAt: item.changedAt, fallbackId: item.channelReservationId, creationListed: listedAsNew.has(item.channelReservationId) });
      result.stored++;
    }
    await withTenant(this.db, organizationId, async (tx) => {
      await tx.channelConnection.update({ where: { id: connectionId }, data: { reservationsPolledAt: new Date(this.now()), reservationsPollError: null, reservationsPollFailures: 0 } });
      await autoResolve(tx, organizationId, `poll:${connectionId}`, 'The reservation queue can be read again.');
    });
    result.ok = true;
    return result;
  }

  private async recordPollFailure(c: ConnectionRow, message: string, r: ProviderCallResult): Promise<void> {
    await withTenant(this.db, c.organizationId, async (tx) => {
      const updated = await tx.channelConnection.update({
        where: { id: c.id },
        data: { reservationsPolledAt: new Date(this.now()), reservationsPollError: message.slice(0, 300), reservationsPollFailures: { increment: 1 } },
        select: { reservationsPollFailures: true },
      });
      if (updated.reservationsPollFailures >= POLL_FAILURES_BEFORE_ALERT) {
        await raiseDiscrepancy(tx, {
          organizationId: c.organizationId,
          propertyId: c.propertyId,
          connectionId: c.id,
          kind: 'POLL_FAILED',
          severity: 'high',
          message: `New ${c.channelName} bookings could not be fetched ${updated.reservationsPollFailures} times in a row: ${message}`.slice(0, 300),
          details: { failures: updated.reservationsPollFailures, outcome: r.outcome, providerCode: r.providerCode ?? null },
          dedupeKey: `poll:${c.id}`,
        });
      }
    });
    this.logger.warn({ connectionId: c.id, outcome: r.outcome }, 'reservation queue could not be read');
  }

  /** Imports future bookings made before the connection (GET /reservations-summary). */
  async importSummary(organizationId: string, connectionId: string, actor: { id: string }, meta: RequestMeta): Promise<{ ok: boolean; stored: number; error: string | null }> {
    const c = await this.loadConnection(organizationId, connectionId);
    this.requireActive(c);
    const r = await this.importSummaryFor(c, { requestId: meta.requestId, actorUserId: actor.id });
    await this.audit.record({ action: 'reservations.summary_imported', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: connectionId, metadata: { ok: r.ok, stored: r.stored }, ...meta });
    return r;
  }

  private async importSummaryFor(c: ConnectionRow, ctx: CallContext): Promise<{ ok: boolean; stored: number; error: string | null }> {
    const provider = this.requireActive(c);
    const r = await provider.reservationsSummary({ channelId: c.channelId, channelPropertyId: c.channelPropertyId }, ctx);
    if (!r.ok || !r.data) return { ok: false, stored: 0, error: r.error?.message ?? 'Could not read the reservation summary.' };
    let stored = 0;
    for (const p of r.data) {
      if (!p.channelReservationId) continue;
      const known = await withTenant(this.db, c.organizationId, (tx) =>
        tx.reservation.findUnique({ where: { connectionId_channelReservationId: { connectionId: c.id, channelReservationId: p.channelReservationId! } }, select: { id: true } }),
      );
      // Bookings already received through the queue are newer than the summary entry.
      if (known) continue;
      await this.ingest(c, p, { source: 'SUMMARY', state: null, changedAt: null, fallbackId: null });
      stored++;
    }
    await withTenant(this.db, c.organizationId, (tx) => tx.channelConnection.update({ where: { id: c.id }, data: { summaryImportedAt: new Date(this.now()) } }));
    return { ok: true, stored, error: null };
  }

  /** Sandbox only: asks Zodomus to create a test booking for the connected test property, then polls. */
  async createTest(organizationId: string, connectionId: string, input: { status: 'new' | 'modified' | 'cancelled'; channelReservationId?: string }, actor: { id: string }, meta: RequestMeta) {
    const c = await this.loadConnection(organizationId, connectionId);
    if (this.config.zodomus.environment !== 'sandbox' || c.environment !== 'sandbox') {
      throw new AppError(409, 'SANDBOX_ONLY', 'Test bookings can only be created while the platform uses the Zodomus sandbox.');
    }
    const provider = this.requireActive(c);
    if (!provider.createTestReservation) throw new AppError(409, 'INTEGRATION_NOT_READY', 'The channel manager does not support test bookings.');
    const ctx = { requestId: meta.requestId, actorUserId: actor.id };
    const r = await provider.createTestReservation({ channelId: c.channelId, channelPropertyId: c.channelPropertyId, status: input.status, channelReservationId: input.channelReservationId }, ctx);
    await this.audit.record({ action: 'reservations.test_created', organizationId, actorUserId: actor.id, entityType: 'channel_connection', entityId: connectionId, metadata: { status: input.status, ok: r.ok, providerCode: r.providerCode ?? null }, ...meta });
    const summary = { ok: r.ok, outcome: r.outcome, httpStatus: r.httpStatus, providerCode: r.providerCode ?? null, providerMessage: r.providerMessage ?? null, error: r.error?.message ?? null };
    if (!r.ok) return { result: summary, poll: null };
    const poll = await this.pollConnection(organizationId, connectionId, ctx);
    return { result: summary, poll };
  }

  // --- storing one reservation -------------------------------------------------------------------

  private encrypt(c: ConnectionRow, channelReservationId: string, purpose: 'guest' | 'payload', value: unknown): string {
    let json = JSON.stringify(value);
    if (json.length > MAX_PAYLOAD_CHARS) json = JSON.stringify({ truncated: true, size: json.length });
    return encryptString(this.key, json, `${purpose}:${c.organizationId}:${c.id}:${channelReservationId}`);
  }

  private decryptGuest(r: { organizationId: string; connectionId: string; channelReservationId: string; guestEnc: string | null }): GuestDetails | null {
    if (!r.guestEnc) return null;
    try {
      return JSON.parse(decryptString(this.key, r.guestEnc, `guest:${r.organizationId}:${r.connectionId}:${r.channelReservationId}`)) as GuestDetails;
    } catch {
      this.logger.error({ connectionId: r.connectionId }, 'could not decrypt guest details');
      return null;
    }
  }

  /** Another API instance may store the same new booking at the same moment; the second attempt then updates it. */
  private async ingest(c: ConnectionRow, p: ParsedReservation, opts: { source: Source; state: ReservationState | null; changedAt: string | null; fallbackId: string | null; creationListed?: boolean }): Promise<void> {
    try {
      await this.ingestOnce(c, p, opts);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      await this.ingestOnce(c, p, opts);
    }
  }

  /** Stores (or updates) one reservation, adjusts availability and opens discrepancies. One tenant transaction. */
  private async ingestOnce(c: ConnectionRow, p: ParsedReservation, opts: { source: Source; state: ReservationState | null; changedAt: string | null; fallbackId: string | null; creationListed?: boolean }): Promise<void> {
    // The queue's booking number is the one that was asked for. Zodomus test mode answers every request with the same
    // fixed booking, so its id can differ from the queue entry; in production a mismatch is flagged for review.
    const channelReservationId = opts.fallbackId ?? p.channelReservationId;
    const idMismatch = !!opts.fallbackId && !!p.channelReservationId && p.channelReservationId !== opts.fallbackId;
    if (!channelReservationId) return;
    const orgId = c.organizationId;

    await withTenant(this.db, orgId, async (tx) => {
      const property = await tx.property.findUniqueOrThrow({ where: { id: c.propertyId }, select: { timezone: true, currency: true } });
      const today = todayIn(property.timezone, new Date(this.now()));
      const existing = await tx.reservation.findUnique({
        where: { connectionId_channelReservationId: { connectionId: c.id, channelReservationId } },
        include: { rooms: true },
      });

      // Queue status is documented (1/2/3); the reservation's own status is the fallback.
      const state: ReservationState | null = opts.state ?? p.state;
      const reasons: string[] = [];
      let status: ReservationStatus;
      if (state) status = state === 'NEW' && existing && existing.status !== 'CONFIRMED' ? existing.status : STATE_TO_STATUS[state];
      else {
        status = existing ? existing.status : 'CONFIRMED';
        reasons.push(`Booking status "${p.rawStatus ?? 'missing'}" was not recognised`);
      }
      const cancelled = status === 'CANCELLED';
      if (idMismatch && c.environment === 'production') reasons.push(`The channel manager returned booking ${p.channelReservationId} for queue entry ${channelReservationId}`);

      const mappings = await tx.channelRoomMapping.findMany({ where: { connectionId: c.id }, include: { rates: { select: { channelRateId: true, ratePlanId: true } } } });
      const byChannelRoom = new Map(mappings.map((m) => [m.channelRoomId, m]));

      // A cancellation may arrive without room details: keep the stored rooms, released from inventory.
      const sourceRooms =
        p.rooms.length === 0 && existing && existing.rooms.length > 0
          ? existing.rooms.map((r) => ({ channelRoomId: r.channelRoomId, name: r.channelRoomName, channelRateId: r.channelRateId, checkIn: r.checkIn ? fromDbDate(r.checkIn) : null, checkOut: r.checkOut ? fromDbDate(r.checkOut) : null, datesPresent: true, guestCount: r.guestCount, totalPrice: null, totalMinor: r.totalMinor, mealPlan: r.mealPlan, guestName: null, remarks: null }))
          : p.rooms.map((r) => ({ ...r, totalMinor: undefined as number | null | undefined }));
      if (!sourceRooms.length && !cancelled) reasons.push('The booking contains no rooms');

      const currency = p.currency ?? property.currency;
      const unmapped = new Set<string>();
      const rooms = sourceRooms.map((r) => {
        const mapping = r.channelRoomId ? byChannelRoom.get(r.channelRoomId) : undefined;
        const validDates = !!r.checkIn && !!r.checkOut && r.checkOut > r.checkIn && daysBetween(r.checkIn, r.checkOut) <= 400;
        if (!validDates) reasons.push(r.datesPresent ? `Arrival/departure dates of room ${r.channelRoomId ?? '?'} are in an unrecognised format` : `Room ${r.channelRoomId ?? '?'} has no arrival/departure dates`);
        if (!mapping) unmapped.add(r.channelRoomId ?? '(no room id)');
        const ratePlanId = mapping && r.channelRateId ? (mapping.rates.find((x) => x.channelRateId === r.channelRateId)?.ratePlanId ?? null) : null;
        return {
          organizationId: orgId,
          propertyId: c.propertyId,
          channelRoomId: r.channelRoomId,
          channelRoomName: r.name,
          channelRateId: r.channelRateId,
          roomTypeId: mapping?.roomTypeId ?? null,
          ratePlanId,
          checkIn: validDates ? toDbDate(r.checkIn!) : null,
          checkOut: validDates ? toDbDate(r.checkOut!) : null,
          guestCount: r.guestCount,
          totalMinor: r.totalMinor !== undefined ? r.totalMinor : r.totalPrice ? decimalToMinor(r.totalPrice, currency) : null,
          mealPlan: r.mealPlan,
          occupiesInventory: !cancelled && !!mapping && validDates,
        };
      });
      if (unmapped.size) reasons.push(`Not mapped to a room type: ${c.channelName} room ${[...unmapped].join(', ')}`);

      const dated = rooms.filter((r) => r.checkIn && r.checkOut);
      const checkIn = dated.length ? dated.map((r) => fromDbDate(r.checkIn!)).reduce(minDate) : null;
      const checkOut = dated.length ? dated.map((r) => fromDbDate(r.checkOut!)).reduce(maxDate) : null;
      const guestCount = rooms.every((r) => r.guestCount === null) ? null : rooms.reduce((n, r) => n + (r.guestCount ?? 0), 0);

      const guest: GuestDetails = {
        ...p.guest,
        customerRemarks: p.guest.remarks,
        reservationRemarks: p.remarks,
        rooms: p.rooms.map((r) => ({ channelRoomId: r.channelRoomId, guestName: r.guestName, remarks: r.remarks })),
      };
      delete (guest as Partial<typeof p.guest>).remarks;
      const hasGuestData = p.rooms.length > 0 || Object.values(p.guest).some((v) => v !== null) || p.remarks !== null;

      const data = {
        status,
        channelStatus: opts.state ? (p.rawStatus ?? null) : p.rawStatus,
        checkIn: checkIn ? toDbDate(checkIn) : null,
        checkOut: checkOut ? toDbDate(checkOut) : null,
        currency,
        totalMinor: bookingTotal(p.totalPrice ? decimalToMinor(p.totalPrice, currency) : null, rooms.map((r) => r.totalMinor)) ?? existing?.totalMinor ?? null,
        guestCount,
        roomCount: rooms.length,
        needsReview: reasons.length > 0,
        reviewReason: reasons.length ? [...new Set(reasons)].join('. ').slice(0, 300) : null,
        channelChangedAt: opts.changedAt ?? existing?.channelChangedAt ?? null,
        cancelledAt: cancelled ? (existing?.cancelledAt ?? new Date(this.now())) : null,
        ...(hasGuestData || !existing ? { guestEnc: this.encrypt(c, channelReservationId, 'guest', guest) } : {}),
        payloadEnc: this.encrypt(c, channelReservationId, 'payload', p.raw),
      };

      let reservationId: string;
      const oldOccupied = (existing?.rooms ?? []).filter((r) => r.occupiesInventory && r.roomTypeId && r.checkIn && r.checkOut);
      if (existing) {
        await tx.reservationRoom.deleteMany({ where: { reservationId: existing.id } });
        await tx.reservation.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
        reservationId = existing.id;
      } else {
        const created = await tx.reservation.create({
          data: {
            ...data,
            organizationId: orgId,
            propertyId: c.propertyId,
            connectionId: c.id,
            provider: c.provider,
            environment: c.environment,
            channelId: c.channelId,
            channelName: c.channelName,
            channelReservationId,
            source: opts.source === 'QUEUE' && c.environment === 'sandbox' ? 'TEST' : opts.source,
            receivedAt: new Date(this.now()),
          },
        });
        reservationId = created.id;
      }
      if (rooms.length) await tx.reservationRoom.createMany({ data: rooms.map((r) => ({ ...r, reservationId })) });

      // Availability changed for the nights released (old) and taken (new), on every connected channel.
      const touched = [...oldOccupied.map((r) => ({ roomTypeId: r.roomTypeId!, from: fromDbDate(r.checkIn!), to: fromDbDate(r.checkOut!) })), ...rooms.filter((r) => r.occupiesInventory).map((r) => ({ roomTypeId: r.roomTypeId!, from: fromDbDate(r.checkIn!), to: fromDbDate(r.checkOut!) }))];
      if (touched.length) {
        const from = maxDate(touched.map((t) => t.from).reduce(minDate), today);
        const to = touched.map((t) => t.to).reduce(maxDate);
        const roomTypeIds = [...new Set(touched.map((t) => t.roomTypeId))];
        if (to > from) {
          const capped = minDate(to, addDays(from, 400));
          await enqueueForChange(tx, { organizationId: orgId, propertyId: c.propertyId, roomTypeIds, availability: true, rates: false, dateFrom: from, dateTo: capped });
          await checkOverbooking(tx, orgId, c.propertyId, roomTypeIds, from, capped);
        }
      }

      // Discrepancies for this booking (one open item per problem; resolved when a later version is fine).
      const label = `${c.channelName} booking ${channelReservationId}`;
      // A stay that has already ended cannot affect availability any more: store it, but raise nothing.
      const ended = !!checkOut && checkOut <= today;
      if (unmapped.size && !cancelled && !ended) {
        await raiseDiscrepancy(tx, {
          organizationId: orgId,
          propertyId: c.propertyId,
          connectionId: c.id,
          reservationId,
          kind: 'UNMAPPED_ROOM',
          severity: 'high',
          message: `${label} is for ${c.channelName} room ${[...unmapped].join(', ')}, which is not mapped to a room type. It was not deducted from availability.`.slice(0, 300),
          details: { channelRoomIds: [...unmapped] },
          dedupeKey: `unmapped:${reservationId}`,
        });
      } else await autoResolve(tx, orgId, `unmapped:${reservationId}`, cancelled ? 'The booking was cancelled.' : 'All rooms of the booking are mapped now.');
      const incomplete = reasons.filter((r) => !r.startsWith('Not mapped'));
      if (incomplete.length && !cancelled && !ended) {
        await raiseDiscrepancy(tx, {
          organizationId: orgId,
          propertyId: c.propertyId,
          connectionId: c.id,
          reservationId,
          kind: 'RESERVATION_INCOMPLETE',
          severity: 'high',
          message: `${label} needs review: ${incomplete.join('. ')}. Rooms without valid dates are not deducted from availability.`.slice(0, 300),
          details: { reasons: incomplete },
          dedupeKey: `incomplete:${reservationId}`,
        });
      } else await autoResolve(tx, orgId, `incomplete:${reservationId}`, cancelled ? 'The booking was cancelled.' : 'A later version of the booking is complete.');
      if (!existing && state && state !== 'NEW' && opts.source !== 'SUMMARY' && !opts.creationListed) {
        await raiseDiscrepancy(tx, {
          organizationId: orgId,
          propertyId: c.propertyId,
          connectionId: c.id,
          reservationId,
          kind: 'UNKNOWN_RESERVATION',
          severity: 'medium',
          message: `A ${state === 'CANCELLED' ? 'cancellation' : 'modification'} arrived for ${label}, which StaySync had not received before. It was stored; check that availability is correct.`,
          details: { state },
          dedupeKey: `unknown:${reservationId}`,
        });
      }
      await autoResolve(tx, orgId, `fetch:${c.id}:${channelReservationId}`, 'The booking was retrieved.');
      await this.audit.record(
        { action: existing ? 'reservation.updated' : 'reservation.received', organizationId: orgId, actorType: 'system', entityType: 'reservation', entityId: reservationId, metadata: { channelReservationId, status, source: opts.source, rooms: rooms.length, needsReview: reasons.length > 0 } },
        tx,
      );
    });
  }

  // --- reading -----------------------------------------------------------------------------------

  async list(organizationId: string, f: { propertyId?: string; status?: ReservationStatus; view: 'upcoming' | 'past' | 'all'; needsReview?: boolean; q?: string; limit: number; offset: number }, canSeeGuests: boolean) {
    return withTenant(this.db, organizationId, async (tx) => {
      const property = f.propertyId ? await tx.property.findUnique({ where: { id: f.propertyId }, select: { timezone: true } }) : null;
      if (f.propertyId && !property) throw new AppError(404, 'NOT_FOUND', 'Property not found');
      const today = toDbDate(todayIn(property?.timezone ?? 'UTC', new Date(this.now())));
      const where: Prisma.ReservationWhereInput = {
        ...(f.propertyId ? { propertyId: f.propertyId } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.needsReview ? { needsReview: true } : {}),
        ...(f.q ? { channelReservationId: { contains: f.q } } : {}),
        ...(f.view === 'upcoming' ? { OR: [{ checkOut: { gte: today } }, { checkOut: null }] } : f.view === 'past' ? { checkOut: { lt: today } } : {}),
      };
      const [total, rows] = await Promise.all([
        tx.reservation.count({ where }),
        tx.reservation.findMany({
          where,
          orderBy: f.view === 'past' ? [{ checkIn: 'desc' }] : [{ checkIn: { sort: 'asc', nulls: 'first' } }, { receivedAt: 'desc' }],
          take: f.limit,
          skip: f.offset,
          include: { property: { select: { name: true } }, rooms: { select: { roomType: { select: { name: true } }, channelRoomName: true } } },
        }),
      ]);
      return {
        total,
        guestDetailsVisible: canSeeGuests,
        items: rows.map((r) => {
          const g = canSeeGuests ? this.decryptGuest(r) : null;
          return {
            ...this.summary(r),
            propertyName: r.property.name,
            roomTypes: [...new Set(r.rooms.map((x) => x.roomType?.name ?? x.channelRoomName ?? 'Unmapped room'))],
            guestName: g ? guestName(g) : null,
          };
        }),
      };
    });
  }

  async get(organizationId: string, id: string, canSeeGuests: boolean, actor: { id: string }, meta: RequestMeta) {
    return withTenant(this.db, organizationId, async (tx) => {
      const r = await tx.reservation.findUnique({
        where: { id },
        include: {
          property: { select: { name: true } },
          rooms: { include: { roomType: { select: { name: true } } } },
          discrepancies: { where: { status: 'OPEN' }, select: { id: true, kind: true, severity: true, message: true } },
        },
      });
      if (!r) throw new AppError(404, 'NOT_FOUND', 'Reservation not found');
      const guest = canSeeGuests ? this.decryptGuest(r) : null;
      if (guest) {
        // Viewing guest personal data is audited.
        await this.audit.record({ action: 'reservation.guest_viewed', organizationId, actorUserId: actor.id, entityType: 'reservation', entityId: r.id, ...meta }, tx);
      }
      const ratePlans = await tx.ratePlan.findMany({ where: { id: { in: r.rooms.map((x) => x.ratePlanId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
      const planName = new Map(ratePlans.map((p) => [p.id, p.name]));
      return {
        ...this.summary(r),
        propertyName: r.property.name,
        guestDetailsVisible: canSeeGuests,
        guest,
        rooms: r.rooms.map((x) => ({
          id: x.id,
          channelRoomId: x.channelRoomId,
          channelRoomName: x.channelRoomName,
          channelRateId: x.channelRateId,
          roomTypeId: x.roomTypeId,
          roomTypeName: x.roomType?.name ?? null,
          ratePlanId: x.ratePlanId,
          ratePlanName: x.ratePlanId ? (planName.get(x.ratePlanId) ?? null) : null,
          checkIn: x.checkIn ? fromDbDate(x.checkIn) : null,
          checkOut: x.checkOut ? fromDbDate(x.checkOut) : null,
          guestCount: x.guestCount,
          total: x.totalMinor !== null && r.currency ? x.totalMinor / 10 ** currencyDigits(r.currency) : null,
          mealPlan: x.mealPlan,
          occupiesInventory: x.occupiesInventory,
        })),
        openDiscrepancies: r.discrepancies,
      };
    });
  }

  private summary(r: { id: string; propertyId: string; connectionId: string; channelId: number; channelName: string; channelReservationId: string; environment: string; status: ReservationStatus; checkIn: Date | null; checkOut: Date | null; currency: string | null; totalMinor: number | null; guestCount: number | null; roomCount: number; needsReview: boolean; reviewReason: string | null; source: string; receivedAt: Date; updatedAt: Date; cancelledAt: Date | null; version: number }) {
    const checkIn = r.checkIn ? fromDbDate(r.checkIn) : null;
    const checkOut = r.checkOut ? fromDbDate(r.checkOut) : null;
    return {
      id: r.id,
      propertyId: r.propertyId,
      connectionId: r.connectionId,
      channelId: r.channelId,
      channelName: r.channelName,
      channelReservationId: r.channelReservationId,
      environment: r.environment,
      isTest: r.environment === 'sandbox',
      status: r.status,
      checkIn,
      checkOut,
      nights: checkIn && checkOut ? daysBetween(checkIn, checkOut) : null,
      currency: r.currency,
      total: r.totalMinor !== null && r.currency ? r.totalMinor / 10 ** currencyDigits(r.currency) : null,
      guestCount: r.guestCount,
      roomCount: r.roomCount,
      needsReview: r.needsReview,
      reviewReason: r.reviewReason,
      source: r.source,
      receivedAt: r.receivedAt,
      updatedAt: r.updatedAt,
      cancelledAt: r.cancelledAt,
      version: r.version,
    };
  }

  /** Support view under an owner-approved grant: booking facts only, never guest data. */
  adminList(organizationId: string) {
    return withTenant(this.db, organizationId, async (tx) => {
      const rows = await tx.reservation.findMany({ orderBy: { receivedAt: 'desc' }, take: 100 });
      return rows.map((r) => this.summary(r));
    });
  }
}

export function guestName(g: GuestDetails): string | null {
  const name = [g.firstName, g.middleName, g.lastName].filter(Boolean).join(' ').trim();
  return name || g.rooms.find((r) => r.guestName)?.guestName || null;
}
