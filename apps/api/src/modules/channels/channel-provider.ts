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

export interface ChannelProvider extends Partial<ChannelSyncProvider> {
  readonly id: string;
  readonly displayName: string;
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
