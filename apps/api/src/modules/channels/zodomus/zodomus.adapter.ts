import type { Logger } from 'pino';
import type { AppConfig } from '../../../config/env.js';
import type {
  ChannelInfo,
  ChannelPropertyRef,
  ChannelRoom,
  ChannelPromotion,
  ChannelPromotionProvider,
  ChannelReservationProvider,
  ChannelSyncProvider,
  DateRange,
  ParsedReservation,
  ReservationQueueItem,
  RateRestrictions,
  CallContext,
  CallRecorder,
  ChannelProvider,
  ProviderCallResult,
  ProviderConfigStatus,
  ReferenceKind,
} from '../channel-provider.js';
import { ZodomusClient, type FetchLike, type ZodomusReadOperation } from './zodomus.client.js';
import { normalizeRoomRates } from './zodomus.mappers.js';
import { parseReservationQueue, parseReservations } from './zodomus.reservations.js';
import { parsePromotions } from './zodomus.promotions.js';

const KIND_TO_OPERATION: Record<ReferenceKind, ZodomusReadOperation> = {
  account: 'account',
  channels: 'channels',
  currencies: 'currencies',
  price_models: 'priceModels',
};

/** Zodomus implementation of the ChannelProvider port (Milestone 4: read-only account calls). */
export class ZodomusAdapter implements ChannelProvider, ChannelSyncProvider, ChannelReservationProvider, ChannelPromotionProvider {
  readonly id = 'zodomus';
  readonly displayName = 'Zodomus';
  private readonly client: ZodomusClient | null;

  constructor(
    private readonly config: AppConfig['zodomus'],
    logger: Logger,
    recorder?: CallRecorder,
    fetchImpl?: FetchLike,
    clientOverrides: { maxRetries?: number; backoffMs?: number } = {},
  ) {
    this.client =
      config.enabled && config.credentialsConfigured
        ? new ZodomusClient({
            baseUrl: config.baseUrl,
            username: config.username ?? '',
            password: config.password ?? '',
            environment: config.environment,
            timeoutMs: config.timeoutMs,
            logger: logger.child({ module: 'zodomus' }),
            recorder,
            fetch: fetchImpl,
            allowProductionWrites: config.allowProductionWrites,
            ...clientOverrides,
          })
        : null;
  }

  configStatus(): ProviderConfigStatus {
    return {
      provider: this.id,
      displayName: this.displayName,
      enabled: this.config.enabled,
      environment: this.config.environment,
      baseUrl: this.config.baseUrl,
      credentialsConfigured: this.config.credentialsConfigured,
    };
  }

  isReady(): boolean {
    return this.client !== null;
  }

  testConnection(ctx: CallContext): Promise<ProviderCallResult> {
    // GET /account is the cheapest authenticated read: it proves reachability and valid credentials.
    return this.require().get('account', ctx);
  }

  fetchReference(kind: ReferenceKind, ctx: CallContext): Promise<ProviderCallResult> {
    return this.require().get(KIND_TO_OPERATION[kind], ctx);
  }

  // --- Milestone 5: mapping and synchronisation (payloads per docs/zodomus-api.md) -----------------

  channels(): ChannelInfo[] {
    // Booking.com is channel 1 at Zodomus (test mode and production). Price models 1 and 2 are Booking-only.
    return [
      {
        channelId: 1,
        name: 'Booking.com',
        priceModels: [
          { id: 2, name: 'Derived prices (price for a standard occupancy + offsets)', recommended: true },
          { id: 1, name: 'Maximum / single (price for full occupancy + single-guest price)' },
        ],
      },
    ];
  }

  activateProperty(ref: ChannelPropertyRef & { priceModelId: number }, ctx: CallContext) {
    return this.require().call('propertyActivation', { body: { channelId: ref.channelId, propertyId: ref.channelPropertyId, priceModelId: ref.priceModelId } }, ctx);
  }

  checkProperty(ref: ChannelPropertyRef, ctx: CallContext) {
    return this.require().call('propertyCheck', { body: { channelId: ref.channelId, propertyId: ref.channelPropertyId } }, ctx);
  }

  deactivateProperty(ref: ChannelPropertyRef, ctx: CallContext) {
    return this.require().call('propertyCancellation', { body: { channelId: ref.channelId, propertyId: ref.channelPropertyId } }, ctx);
  }

  async fetchRoomRates(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ChannelRoom[]>> {
    const r = await this.require().call('roomRates', { query: { channelId: ref.channelId, propertyId: ref.channelPropertyId } }, ctx);
    if (!r.ok) return { ...r, data: undefined };
    const rooms = normalizeRoomRates(r.data);
    if (!rooms) {
      return { ...r, ok: false, outcome: 'INVALID_RESPONSE', data: undefined, error: { code: 'UNEXPECTED_SHAPE', message: 'Zodomus returned rooms and rates in an unexpected format.' } };
    }
    return { ...r, data: rooms };
  }

  activateRooms(ref: ChannelPropertyRef & { rooms: { channelRoomId: string; name: string; quantity: number; channelRateIds: string[] }[] }, ctx: CallContext) {
    return this.require().call(
      'roomsActivation',
      {
        body: {
          channelId: ref.channelId,
          propertyId: ref.channelPropertyId,
          rooms: ref.rooms.map((r) => ({ roomId: r.channelRoomId, roomName: r.name, quantity: r.quantity, status: 1, rates: r.channelRateIds })),
        },
      },
      ctx,
    );
  }

  pushAvailability(ref: ChannelPropertyRef & DateRange & { channelRoomId: string; available: number }, ctx: CallContext) {
    return this.require().call(
      'availability',
      { body: { channelId: ref.channelId, propertyId: ref.channelPropertyId, roomId: ref.channelRoomId, dateFrom: ref.dateFrom, dateTo: ref.dateTo, availability: ref.available } },
      ctx,
    );
  }

  pushRates(
    ref: ChannelPropertyRef & DateRange & { channelRoomId: string; channelRateId: string; currency: string; price: string; priceSingle?: string; restrictions: RateRestrictions },
    ctx: CallContext,
  ) {
    const r = ref.restrictions;
    const body: Record<string, unknown> = {
      channelId: ref.channelId,
      propertyId: ref.channelPropertyId,
      roomId: ref.channelRoomId,
      rateId: ref.channelRateId,
      dateFrom: ref.dateFrom,
      dateTo: ref.dateTo,
      currencyCode: ref.currency,
      prices: ref.priceSingle !== undefined ? { price: ref.price, priceSingle: ref.priceSingle } : { price: ref.price },
      // Restrictions are strings in the Zodomus examples ("0"/"1", "3").
      closed: r.closed ? '1' : '0',
      closedOnArrival: r.closedOnArrival ? '1' : '0',
      closedOnDeparture: r.closedOnDeparture ? '1' : '0',
    };
    if (r.minStay !== undefined && r.minStay !== null) body['minimumStay'] = String(r.minStay);
    if (r.maxStay !== undefined && r.maxStay !== null) body['maximumStay'] = String(r.maxStay);
    return this.require().call('rates', { body }, ctx);
  }

  pushDerivedRates(
    ref: ChannelPropertyRef & { channelRoomId: string; channelRateId: string; baseOccupancy: number; occupancy: { persons: number; percentage: number }[] },
    ctx: CallContext,
  ) {
    return this.require().call(
      'ratesDerived',
      {
        body: {
          channelId: ref.channelId,
          propertyId: ref.channelPropertyId,
          roomId: ref.channelRoomId,
          rateId: ref.channelRateId,
          baseOccupancy: String(ref.baseOccupancy),
          occupancy: ref.occupancy.map((o) => ({ persons: String(o.persons), percentage: String(o.percentage), round: '1' })),
        },
      },
      ctx,
    );
  }

  // --- Milestone 6: reservations. GET /reservations-cc (card data) is never called. ---------------

  async reservationQueue(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ReservationQueueItem[]>> {
    const r = await this.require().call('reservationsQueue', { query: { channelId: ref.channelId, propertyId: ref.channelPropertyId } }, ctx);
    if (!r.ok) return { ...r, data: undefined };
    const items = parseReservationQueue(r.data);
    if (!items) return unexpected(r, 'Zodomus returned the reservation queue in an unexpected format.');
    return { ...r, data: items };
  }

  async fetchReservation(ref: ChannelPropertyRef & { channelReservationId: string }, ctx: CallContext): Promise<ProviderCallResult<ParsedReservation[]>> {
    const r = await this.require().call('reservations', { query: { channelId: ref.channelId, propertyId: ref.channelPropertyId, reservationId: ref.channelReservationId } }, ctx);
    if (!r.ok) return { ...r, data: undefined };
    const items = parseReservations(r.data);
    if (!items) return unexpected(r, 'Zodomus returned the reservation in an unexpected format.');
    return { ...r, data: items };
  }

  async reservationsSummary(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ParsedReservation[]>> {
    const r = await this.require().call('reservationsSummary', { query: { channelId: ref.channelId, propertyId: ref.channelPropertyId } }, ctx);
    if (!r.ok) return { ...r, data: undefined };
    const items = parseReservations(r.data);
    if (!items) return unexpected(r, 'Zodomus returned the reservation summary in an unexpected format.');
    return { ...r, data: items };
  }

  createTestReservation(ref: ChannelPropertyRef & { status: 'new' | 'modified' | 'cancelled'; channelReservationId?: string }, ctx: CallContext): Promise<ProviderCallResult> {
    if (this.config.environment !== 'sandbox') return Promise.reject(new Error('Test reservations can only be created in the Zodomus sandbox'));
    const body: Record<string, unknown> = { channelId: ref.channelId, propertyId: ref.channelPropertyId, status: ref.status };
    if (ref.channelReservationId) body['reservationId'] = ref.channelReservationId;
    return this.require().call('reservationsCreateTest', { body }, ctx);
  }

  // --- Promotions (documented: GET /promotions, POST /activate-promotion, POST /deactivate-promotion; query parameters) ---

  async promotions(ref: ChannelPropertyRef & { active: boolean }, ctx: CallContext): Promise<ProviderCallResult<ChannelPromotion[]>> {
    const r = await this.require().call('promotions', { query: { channelId: ref.channelId, propertyId: ref.channelPropertyId, active: ref.active ? 1 : 0 } }, ctx);
    if (!r.ok) return { ...r, data: undefined };
    const items = parsePromotions(r.data);
    if (!items) return unexpected(r, 'Zodomus returned promotions in an unexpected format.');
    return { ...r, data: items };
  }

  setPromotionActive(ref: ChannelPropertyRef & { promotionId: string; active: boolean }, ctx: CallContext): Promise<ProviderCallResult> {
    return this.require().call(ref.active ? 'promotionActivate' : 'promotionDeactivate', { query: { channelId: ref.channelId, propertyId: ref.channelPropertyId, promotionId: ref.promotionId } }, ctx);
  }

  private require(): ZodomusClient {
    if (!this.client) throw new Error('Zodomus is not enabled or not configured');
    return this.client;
  }
}

function unexpected<T>(r: ProviderCallResult, message: string): ProviderCallResult<T> {
  return { ...r, ok: false, outcome: 'INVALID_RESPONSE', data: undefined, error: { code: 'UNEXPECTED_SHAPE', message } };
}
