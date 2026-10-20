import type { Logger } from 'pino';
import type { AppConfig } from '../../../config/env.js';
import type {
  CallContext,
  CallRecorder,
  ChannelInfo,
  ChannelPropertyRef,
  ChannelProvider,
  ChannelReservationProvider,
  ChannelRoom,
  ChannelSyncProvider,
  DateRange,
  ParsedReservation,
  ProviderCallResult,
  ProviderConfigStatus,
  RateRestrictions,
  ReservationQueueItem,
} from '../channel-provider.js';
import type { FetchLike } from '../zodomus/zodomus.client.js';
import { Beds24Client, type Beds24Credits } from './beds24.client.js';
import { IMPORTED_STATUSES, PRICE_SLOT_RE, bookingsToQueue, dataList, nextPageExists, parseBooking, parseRooms, toBeds24Range } from './beds24.mappers.js';

/** StaySync's one "channel" at Beds24: the Beds24 calendar, which Beds24 passes on to every OTA connected there. */
export const BEDS24_CHANNEL_ID = 1;
const MAX_PAGES = 20;
/** Overlap when asking for bookings changed since the last poll (clock differences, slow writes at Beds24). */
const POLL_OVERLAP_MS = 10 * 60_000;
const FIRST_POLL_WINDOW_MS = 60 * 60_000;
const CACHE_MS = 5 * 60_000;

type Obj = Record<string, unknown>;
const ID_RE = /^\d{1,12}$/;

/**
 * Beds24 API v2 implementation of the ChannelProvider port (sync + reservations; no promotions).
 * - Property / rooms: GET /properties (read-only; rooms and price slots are mapped in StaySync).
 * - Availability and prices: POST /inventory/rooms/calendar (numAvail, price1…price16, minStay/maxStay, override).
 * - Bookings: GET /bookings filtered by property and modification time.
 * Nothing is created or deleted at Beds24: connecting/disconnecting only changes StaySync.
 */
export class Beds24Adapter implements ChannelProvider, ChannelSyncProvider, ChannelReservationProvider {
  readonly id = 'beds24';
  readonly displayName = 'Beds24';
  /** A rate update can set the calendar override back to "none", which makes Beds24 recompute numAvail. */
  readonly resendAvailabilityAfterRates = true;
  private readonly client: Beds24Client | null;
  /** Bookings read by the last queue call, so each one is not fetched again (saves Beds24 credits). */
  private readonly cache = new Map<string, { at: number; items: Map<string, ParsedReservation> }>();

  constructor(
    private readonly config: AppConfig['beds24'],
    logger: Logger,
    recorder?: CallRecorder,
    fetchImpl?: FetchLike,
    clientOverrides: { maxRetries?: number; backoffMs?: number; now?: () => number } = {},
    private readonly now: () => number = clientOverrides.now ?? Date.now,
  ) {
    this.client =
      config.enabled && config.credentialsConfigured
        ? new Beds24Client({
            baseUrl: config.baseUrl,
            refreshToken: config.refreshToken ?? '',
            timeoutMs: config.timeoutMs,
            logger: logger.child({ module: 'beds24' }),
            recorder,
            fetch: fetchImpl,
            allowWrites: config.allowWrites,
            calendarToInclusive: config.calendarToInclusive,
            ...clientOverrides,
          })
        : null;
  }

  configStatus(): ProviderConfigStatus {
    return { provider: this.id, displayName: this.displayName, enabled: this.config.enabled, environment: 'production', baseUrl: this.config.baseUrl, credentialsConfigured: this.config.credentialsConfigured };
  }

  /** Extra health facts for the admin page (no secrets). */
  details(): { allowWrites: boolean; calendarToInclusive: boolean | null; credits: Beds24Credits | null } {
    return { allowWrites: this.config.allowWrites, calendarToInclusive: this.config.calendarToInclusive, credits: this.client?.creditStatus() ?? null };
  }

  isReady(): boolean {
    return this.client !== null;
  }

  testConnection(ctx: CallContext): Promise<ProviderCallResult> {
    return this.require().call('authDetails', {}, ctx);
  }

  fetchReference(): Promise<ProviderCallResult> {
    return Promise.resolve({ ok: false, operation: 'reference', httpStatus: null, outcome: 'CLIENT_ERROR', durationMs: 0, attempts: 0, error: { code: 'NOT_SUPPORTED', message: 'Beds24 has no reference lists.' } });
  }

  channels(): ChannelInfo[] {
    return [{ channelId: BEDS24_CHANNEL_ID, name: 'Beds24', priceModels: [{ id: 1, name: 'Beds24 calendar prices (price per room and night, price1 … price16)', recommended: true }] }];
  }

  // --- property and rooms (read-only) ---------------------------------------------------------------

  private async property(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ChannelRoom[]>> {
    if (!ID_RE.test(ref.channelPropertyId)) return invalid('The Beds24 property id is a number (Settings > Properties in Beds24).');
    const r = await this.require().call('properties', { query: { id: ref.channelPropertyId, includeAllRooms: true, includePriceRules: true } }, ctx);
    if (!r.ok) return { ...r, data: undefined };
    const rooms = parseRooms(r.data, ref.channelPropertyId);
    if (!rooms) {
      return dataList(r.data)
        ? { ...r, ok: false, outcome: 'CLIENT_ERROR', data: undefined, error: { code: 'PROPERTY_NOT_FOUND', message: `Beds24 property ${ref.channelPropertyId} is not in the account of this token.` } }
        : unexpected(r, 'Beds24 returned the property in an unexpected format.');
    }
    return { ...r, data: rooms };
  }

  async activateProperty(ref: ChannelPropertyRef & { priceModelId: number }, ctx: CallContext): Promise<ProviderCallResult> {
    const r = await this.property(ref, ctx);
    return { ...r, data: undefined };
  }

  async checkProperty(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult> {
    const r = await this.property(ref, ctx);
    return { ...r, data: undefined, providerMessage: r.ok ? `Property found · ${r.data?.length ?? 0} room type(s)` : r.providerMessage };
  }

  /** Nothing to undo at Beds24 (StaySync only stops sending). */
  deactivateProperty(): Promise<ProviderCallResult> {
    return Promise.resolve(local('disconnect'));
  }

  fetchRoomRates(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ChannelRoom[]>> {
    return this.property(ref, ctx);
  }

  /** Beds24 needs no activation: the mapping lives in StaySync. The room ids are checked when loaded. */
  activateRooms(): Promise<ProviderCallResult> {
    return Promise.resolve(local('rooms-activation'));
  }

  // --- calendar writes -------------------------------------------------------------------------------

  private async writeCalendar(roomId: string, entry: Obj, ctx: CallContext): Promise<ProviderCallResult> {
    if (!ID_RE.test(roomId)) return invalid(`Beds24 room id "${roomId}" is not valid.`);
    const client = this.require();
    client.assertWritable();
    const r = await client.call('calendarSet', { body: [{ roomId: Number(roomId), calendar: [entry] }] }, ctx);
    if (!r.ok) return r;
    // 201: [{ success, new, modified, errors[], warnings[], info[] }] per room.
    if (!Array.isArray(r.data)) return unexpected(r, 'Beds24 returned an unexpected calendar response.');
    const failed = r.data.find((x) => !x || typeof x !== 'object' || (x as Obj)['success'] !== true) as Obj | undefined;
    if (failed) {
      const errs = Array.isArray(failed?.['errors']) ? failed['errors'] : [];
      const describe = (e: unknown): string => {
        if (typeof e === 'string') return e;
        if (!e || typeof e !== 'object') return '';
        const o = e as Obj;
        const m = o['message'] ?? o['error'];
        return typeof m === 'string' ? m : JSON.stringify(e);
      };
      const msg = errs.map(describe).join('; ').slice(0, 200) || 'calendar update not accepted';
      return { ...r, ok: false, outcome: 'PROVIDER_ERROR', providerMessage: msg, error: { code: 'PROVIDER_ERROR', message: `Beds24 reported an error (${msg})` } };
    }
    return r;
  }

  private range(ref: DateRange) {
    return toBeds24Range(ref.dateFrom, ref.dateTo, this.require().calendarToInclusive === true);
  }

  pushAvailability(ref: ChannelPropertyRef & DateRange & { channelRoomId: string; available: number }, ctx: CallContext): Promise<ProviderCallResult> {
    return this.writeCalendar(ref.channelRoomId, { ...this.range(ref), numAvail: Math.max(0, Math.trunc(ref.available)) }, ctx);
  }

  /**
   * Price of one slot. Beds24 keeps stay restrictions per room (not per price), so they are sent only by the rate
   * plan mapped to price1. A closed rate removes its price for those dates (Beds24: "set a field to null to remove it").
   */
  pushRates(
    ref: ChannelPropertyRef & DateRange & { channelRoomId: string; channelRateId: string; currency: string; price: string; priceSingle?: string; restrictions: RateRestrictions },
    ctx: CallContext,
  ): Promise<ProviderCallResult> {
    if (!PRICE_SLOT_RE.test(ref.channelRateId)) return Promise.resolve(invalid(`"${ref.channelRateId}" is not a Beds24 price slot (price1 … price16).`));
    const r = ref.restrictions;
    const price = Number(ref.price);
    if (!Number.isFinite(price) || price < 0) return Promise.resolve(invalid('The price is not a valid amount.'));
    const entry: Obj = { ...this.range(ref), [ref.channelRateId]: r.closed ? null : price };
    if (ref.channelRateId === 'price1') {
      entry['minStay'] = r.minStay && r.minStay >= 1 && r.minStay <= 365 ? r.minStay : null;
      entry['maxStay'] = r.maxStay && r.maxStay >= 1 && r.maxStay <= 364 ? r.maxStay : null;
      entry['override'] = r.closedOnArrival && r.closedOnDeparture ? 'noCheckInOrCheckOut' : r.closedOnArrival ? 'noCheckIn' : r.closedOnDeparture ? 'noCheckOut' : 'none';
    }
    return this.writeCalendar(ref.channelRoomId, entry, ctx);
  }

  /** Beds24 has no occupancy-derived prices through this API. */
  pushDerivedRates(): Promise<ProviderCallResult> {
    return Promise.resolve(local('rates-derived'));
  }

  // --- bookings (read-only; card fields are dropped) ---------------------------------------------------

  private async bookingPages(query: Record<string, string | number | boolean | undefined | readonly string[]>, ctx: CallContext): Promise<ProviderCallResult<Obj[]>> {
    const all: Obj[] = [];
    let last: ProviderCallResult | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.require().call('bookings', { query: { ...query, page: page > 1 ? page : undefined } }, ctx);
      if (!r.ok) return { ...r, data: undefined };
      const items = dataList(r.data);
      if (!items) return unexpected(r, 'Beds24 returned bookings in an unexpected format.');
      all.push(...items);
      last = r;
      if (!nextPageExists(r.data)) break;
    }
    return { ...last!, data: all };
  }

  private statusQuery(): Record<string, readonly string[]> {
    // Without a status filter Beds24 leaves out cancelled bookings; cancellations must be seen.
    return { status: IMPORTED_STATUSES };
  }

  async reservationQueue(ref: ChannelPropertyRef & { since?: Date | null }, ctx: CallContext): Promise<ProviderCallResult<ReservationQueueItem[]>> {
    if (!ID_RE.test(ref.channelPropertyId)) return invalid('The Beds24 property id is a number.');
    const sinceMs = ref.since ? ref.since.getTime() - POLL_OVERLAP_MS : this.now() - FIRST_POLL_WINDOW_MS;
    const modifiedFrom = new Date(sinceMs).toISOString().slice(0, 19);
    const r = await this.bookingPages({ propertyId: ref.channelPropertyId, modifiedFrom, ...this.statusQuery() }, ctx);
    if (!r.ok || !r.data) return { ...r, data: undefined };
    const { queue, parsed } = bookingsToQueue(r.data, sinceMs);
    this.cache.set(ref.channelPropertyId, { at: this.now(), items: parsed });
    return { ...r, data: queue };
  }

  async fetchReservation(ref: ChannelPropertyRef & { channelReservationId: string }, ctx: CallContext): Promise<ProviderCallResult<ParsedReservation[]>> {
    const cached = this.cache.get(ref.channelPropertyId);
    const hit = cached && this.now() - cached.at < CACHE_MS ? cached.items.get(ref.channelReservationId) : undefined;
    if (hit) return { ...local('bookings-cache'), data: [hit] };
    if (!ID_RE.test(ref.channelReservationId)) return invalid('The Beds24 booking id is a number.');
    const r = await this.bookingPages({ propertyId: ref.channelPropertyId, id: ref.channelReservationId, ...this.statusQuery() }, ctx);
    if (!r.ok || !r.data) return { ...r, data: undefined };
    return { ...r, data: r.data.map(parseBooking).filter((p) => p.channelReservationId === ref.channelReservationId) };
  }

  /** Upcoming bookings that already exist (Beds24 returns upcoming bookings by default). */
  async reservationsSummary(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ParsedReservation[]>> {
    if (!ID_RE.test(ref.channelPropertyId)) return invalid('The Beds24 property id is a number.');
    const r = await this.bookingPages({ propertyId: ref.channelPropertyId, status: ['confirmed', 'request', 'new'] }, ctx);
    if (!r.ok || !r.data) return { ...r, data: undefined };
    return { ...r, data: r.data.map(parseBooking).filter((p) => p.channelReservationId !== null && p.state === 'NEW') };
  }

  private require(): Beds24Client {
    if (!this.client) throw new Error('Beds24 is not enabled or not configured');
    return this.client;
  }
}

/** Successful step that needs no call at Beds24. */
function local(operation: string): ProviderCallResult {
  return { ok: true, operation, httpStatus: null, outcome: 'SUCCESS', durationMs: 0, attempts: 0, providerMessage: 'OK' };
}
function invalid<T>(message: string): ProviderCallResult<T> {
  return { ok: false, operation: 'validate', httpStatus: null, outcome: 'CLIENT_ERROR', durationMs: 0, attempts: 0, error: { code: 'INVALID_INPUT', message } };
}
function unexpected<T>(r: ProviderCallResult, message: string): ProviderCallResult<T> {
  return { ...r, ok: false, outcome: 'INVALID_RESPONSE', data: undefined, error: { code: 'UNEXPECTED_SHAPE', message } };
}
