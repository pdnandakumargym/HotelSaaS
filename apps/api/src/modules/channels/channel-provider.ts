/**
 * Channel-provider abstraction. The rest of the application talks to booking channels only
 * through this interface, so Zodomus can be replaced or joined by another provider later.
 *
 * Milestone 4 scope: read-only account-level calls. Mapping, rates, availability and
 * reservations are added in later milestones, once the authenticated API reference is available.
 */

export type ProviderEnvironment = 'sandbox' | 'production';

export type CallOutcome =
  | 'SUCCESS'
  | 'AUTH_ERROR'
  | 'CLIENT_ERROR'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  /** HTTP 2xx, but the provider's own status envelope reports an error. */
  | 'PROVIDER_ERROR';

/** Read-only reference data kinds available in Milestone 4. */
export const REFERENCE_KINDS = ['account', 'channels', 'currencies', 'price_models'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface CallContext {
  requestId?: string;
  actorUserId?: string;
}

export interface ProviderCallResult<T = unknown> {
  ok: boolean;
  operation: string;
  httpStatus: number | null;
  outcome: CallOutcome;
  durationMs: number;
  attempts: number;
  data?: T;
  /** Provider status envelope (Zodomus: status.returnCode / status.returnMessage), when present. */
  providerCode?: number | null;
  providerMessage?: string | null;
  /** Safe, generic description. Never contains credentials or raw response bodies. */
  error?: { code: string; message: string };
}

/** Metadata of one outbound call, handed to a recorder (database log, metrics). */
export interface CallRecord {
  provider: string;
  environment: ProviderEnvironment;
  operation: string;
  httpMethod: 'GET' | 'POST';
  path: string;
  httpStatus: number | null;
  outcome: CallOutcome;
  durationMs: number;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  providerCode?: number | null;
  providerMessage?: string | null;
  requestId?: string;
  actorUserId?: string;
}

export interface CallRecorder {
  record(entry: CallRecord): Promise<void>;
}

export interface ProviderConfigStatus {
  provider: string;
  displayName: string;
  enabled: boolean;
  environment: ProviderEnvironment;
  baseUrl: string;
  credentialsConfigured: boolean;
}

export interface ChannelProvider extends Partial<ChannelSyncProvider>, Partial<ChannelReservationProvider>, Partial<ChannelPromotionProvider> {
  readonly id: string;
  readonly displayName: string;
  /** True when a rate update can change availability at the provider, so availability is re-sent after it (Beds24). */
  readonly resendAvailabilityAfterRates?: boolean;
  configStatus(): ProviderConfigStatus;
  /** True when enabled and credentials are present. Calls are refused otherwise. */
  isReady(): boolean;
  /** Cheapest authenticated read used to verify credentials and reachability. */
  testConnection(ctx: CallContext): Promise<ProviderCallResult>;
  fetchReference(kind: ReferenceKind, ctx: CallContext): Promise<ProviderCallResult>;
}

// ---------------------------------------------------------------------------
// Milestone 5: property activation, room/rate mapping, availability and rates
// ---------------------------------------------------------------------------

/** A channel reachable through the provider (e.g. Booking.com) and the price models it accepts. */
export interface ChannelInfo {
  channelId: number;
  name: string;
  priceModels: { id: number; name: string; recommended?: boolean }[];
}

export interface ChannelPropertyRef {
  channelId: number;
  channelPropertyId: string;
}

export interface ChannelRate {
  id: string;
  name: string;
  active: boolean | null;
  maxPersons: number | null;
}
export interface ChannelRoom {
  id: string;
  name: string;
  rates: ChannelRate[];
}

/** Calendar dates are YYYY-MM-DD in the property's time zone; dateTo is exclusive. */
export interface DateRange {
  dateFrom: string;
  dateTo: string;
}

export interface RateRestrictions {
  closed?: boolean;
  minStay?: number | null;
  maxStay?: number | null;
  closedOnArrival?: boolean;
  closedOnDeparture?: boolean;
}

export interface ChannelSyncProvider {
  channels(): ChannelInfo[];
  activateProperty(ref: ChannelPropertyRef & { priceModelId: number }, ctx: CallContext): Promise<ProviderCallResult>;
  checkProperty(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult>;
  deactivateProperty(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult>;
  /** Result `data` is ChannelRoom[] when ok. */
  fetchRoomRates(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ChannelRoom[]>>;
  activateRooms(ref: ChannelPropertyRef & { rooms: { channelRoomId: string; name: string; quantity: number; channelRateIds: string[] }[] }, ctx: CallContext): Promise<ProviderCallResult>;
  pushAvailability(ref: ChannelPropertyRef & DateRange & { channelRoomId: string; available: number }, ctx: CallContext): Promise<ProviderCallResult>;
  pushRates(
    ref: ChannelPropertyRef & DateRange & { channelRoomId: string; channelRateId: string; currency: string; price: string; priceSingle?: string; restrictions: RateRestrictions },
    ctx: CallContext,
  ): Promise<ProviderCallResult>;
  pushDerivedRates(
    ref: ChannelPropertyRef & { channelRoomId: string; channelRateId: string; baseOccupancy: number; occupancy: { persons: number; percentage: number }[] },
    ctx: CallContext,
  ): Promise<ProviderCallResult>;
}

// ---------------------------------------------------------------------------
// Milestone 6: reservations (never card data)
// ---------------------------------------------------------------------------

export type ReservationState = 'NEW' | 'MODIFIED' | 'CANCELLED';

export interface ReservationQueueItem {
  channelReservationId: string;
  state: ReservationState | null;
  rawStatus: string | null;
  /** Timestamp of the change as sent by the channel manager (format not specified; stored as text). */
  changedAt: string | null;
}

export interface ParsedReservationRoom {
  channelRoomId: string | null;
  name: string | null;
  channelRateId: string | null;
  /** YYYY-MM-DD or null when missing / not recognisable. */
  checkIn: string | null;
  checkOut: string | null;
  /** True when both date fields were sent (so a null date means "unrecognised format"). */
  datesPresent: boolean;
  guestCount: number | null;
  /** Decimal string as sent ("260.00"). */
  totalPrice: string | null;
  mealPlan: string | null;
  /** Personal data: stored encrypted only. */
  guestName: string | null;
  remarks: string | null;
}

/** Guest personal data. Stored only encrypted; never logged. */
export interface ParsedGuest {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  countryCode: string | null;
  remarks: string | null;
}

export interface ParsedReservation {
  channelReservationId: string | null;
  state: ReservationState | null;
  rawStatus: string | null;
  currency: string | null;
  totalPrice: string | null;
  remarks: string | null;
  guest: ParsedGuest;
  rooms: ParsedReservationRoom[];
  /** Sanitized provider item (card-like keys removed), kept encrypted for support. */
  raw: unknown;
}

export interface ChannelReservationProvider {
  /** `since`: time of the last successful poll (providers without a queue list bookings changed since then). */
  reservationQueue(ref: ChannelPropertyRef & { since?: Date | null }, ctx: CallContext): Promise<ProviderCallResult<ReservationQueueItem[]>>;
  fetchReservation(ref: ChannelPropertyRef & { channelReservationId: string }, ctx: CallContext): Promise<ProviderCallResult<ParsedReservation[]>>;
  /** Future reservations made before the property was connected to the channel manager. */
  reservationsSummary(ref: ChannelPropertyRef, ctx: CallContext): Promise<ProviderCallResult<ParsedReservation[]>>;
  /** Sandbox only: asks the channel manager to create a test reservation. */
  createTestReservation?(ref: ChannelPropertyRef & { status: 'new' | 'modified' | 'cancelled'; channelReservationId?: string }, ctx: CallContext): Promise<ProviderCallResult>;
}

// ---------------------------------------------------------------------------
// Promotions (Booking.com via Zodomus): list, activate, deactivate
// ---------------------------------------------------------------------------

export interface ChannelPromotion {
  id: string;
  name: string | null;
  type: string | null;
  active: boolean | null;
  nonRefundable: boolean | null;
  minStayThrough: number | null;
  /** As sent by the channel (percentage per Booking.com), not interpreted. */
  discount: string | null;
  stayFrom: string | null;
  stayTo: string | null;
  bookFrom: string | null;
  bookTo: string | null;
  roomIds: string[];
  stats: { revenue: string | null; currency: string | null; roomNights: number | null; bookings: number | null; cancellations: number | null };
}

export interface ChannelPromotionProvider {
  promotions(ref: ChannelPropertyRef & { active: boolean }, ctx: CallContext): Promise<ProviderCallResult<ChannelPromotion[]>>;
  setPromotionActive(ref: ChannelPropertyRef & { promotionId: string; active: boolean }, ctx: CallContext): Promise<ProviderCallResult>;
}
