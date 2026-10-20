import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_BASE } from './api.config';

export type ReservationStatus = 'CONFIRMED' | 'MODIFIED' | 'CANCELLED';

export interface ReservationSummary {
  id: string;
  propertyId: string;
  propertyName: string;
  connectionId: string;
  channelName: string;
  channelReservationId: string;
  environment: string;
  isTest: boolean;
  status: ReservationStatus;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  currency: string | null;
  total: number | null;
  guestCount: number | null;
  roomCount: number;
  roomTypes: string[];
  guestName: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  source: 'QUEUE' | 'SUMMARY' | 'TEST';
  receivedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  version: number;
}

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

export interface ReservationDetail extends Omit<ReservationSummary, 'roomTypes' | 'guestName'> {
  guestDetailsVisible: boolean;
  guest: GuestDetails | null;
  rooms: {
    id: string;
    channelRoomId: string | null;
    channelRoomName: string | null;
    channelRateId: string | null;
    roomTypeId: string | null;
    roomTypeName: string | null;
    ratePlanName: string | null;
    checkIn: string | null;
    checkOut: string | null;
    guestCount: number | null;
    total: number | null;
    mealPlan: string | null;
    occupiesInventory: boolean;
  }[];
  openDiscrepancies: { id: string; kind: string; severity: string; message: string }[];
}

export interface ReservationFilter {
  propertyId?: string;
  status?: ReservationStatus | '';
  view: 'upcoming' | 'past' | 'all';
  needsReview?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface PollResult {
  ok: boolean;
  queued: number;
  stored: number;
  skipped: number;
  failed: number;
  summary: { ok: boolean; stored: number } | null;
  error: string | null;
}

export interface SyncStatusJob {
  id: string;
  kind: 'AVAILABILITY' | 'RATES' | 'RATES_DERIVED';
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  roomTypeName: string | null;
  ratePlanName: string | null;
  dateFrom: string;
  dateTo: string;
  attempts: number;
  callsMade: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SyncStatus {
  connectionId: string;
  propertyId: string;
  propertyName: string;
  channelName: string;
  channelPropertyId: string;
  environment: string;
  connectionStatus: string;
  health: 'in_sync' | 'syncing' | 'attention' | 'not_active';
  jobs: { pending: number; running: number; succeeded24h: number; failed24h: number; lastSuccessAt: string | null };
  reservations: { lastPolledAt: string | null; pollError: string | null; consecutiveFailures: number; summaryImportedAt: string | null; lastReceivedAt: string | null; total: number };
  openDiscrepancies: number;
  recentJobs: SyncStatusJob[];
}

export type DiscrepancyKind = 'OVERBOOKING' | 'UNMAPPED_ROOM' | 'RESERVATION_INCOMPLETE' | 'RESERVATION_FETCH_FAILED' | 'UNKNOWN_RESERVATION' | 'SYNC_FAILED' | 'POLL_FAILED';
export interface Discrepancy {
  id: string;
  propertyId: string;
  propertyName: string;
  connectionId: string | null;
  reservationId: string | null;
  channelReservationId: string | null;
  kind: DiscrepancyKind;
  severity: 'high' | 'medium' | 'low';
  status: 'OPEN' | 'RESOLVED' | 'IGNORED';
  message: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  autoResolved: boolean;
  resolutionNote: string | null;
}

export const DISCREPANCY_KIND: Record<DiscrepancyKind, { label: string; action: string }> = {
  OVERBOOKING: { label: 'Overbooking', action: 'Move or cancel a booking, or bring a room back into service.' },
  UNMAPPED_ROOM: { label: 'Unmapped room', action: 'Map the channel room on Room & Rate Mapping, then adjust availability for the booked nights.' },
  RESERVATION_INCOMPLETE: { label: 'Incomplete booking', action: 'Check the booking in the channel extranet and block the nights by hand if needed.' },
  RESERVATION_FETCH_FAILED: { label: 'Booking not retrieved', action: 'StaySync retries on every poll. If it persists, check the booking in the extranet.' },
  UNKNOWN_RESERVATION: { label: 'Unknown booking changed', action: 'Compare availability with the channel extranet for those dates.' },
  SYNC_FAILED: { label: 'Update not delivered', action: 'Retry the update on Synchronization Status, or send all availability and rates again.' },
  POLL_FAILED: { label: 'Bookings not fetched', action: 'Check the connection status. New bookings are fetched again automatically.' },
};

interface Envelope<T> {
  data: T;
}

@Injectable({ providedIn: 'root' })
export class OpsApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private get org(): string {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return `${API_BASE}/organizations/${org.organizationId}`;
  }
  private data<T>(o: Observable<Envelope<T>>): Observable<T> {
    return o.pipe(map((r) => r.data));
  }
  private conn(propertyId: string, connectionId: string): string {
    return `${this.org}/properties/${encodeURIComponent(propertyId)}/channel-connections/${encodeURIComponent(connectionId)}/reservations`;
  }

  reservations(f: ReservationFilter): Observable<{ total: number; guestDetailsVisible: boolean; items: ReservationSummary[] }> {
    const params: Record<string, string | number> = { view: f.view, limit: f.limit ?? 50, offset: f.offset ?? 0 };
    if (f.propertyId) params['propertyId'] = f.propertyId;
    if (f.status) params['status'] = f.status;
    if (f.needsReview) params['needsReview'] = 'true';
    if (f.q) params['q'] = f.q;
    return this.data(this.http.get<Envelope<{ total: number; guestDetailsVisible: boolean; items: ReservationSummary[] }>>(`${this.org}/reservations`, { params }));
  }
  reservation(id: string): Observable<ReservationDetail> {
    return this.data(this.http.get<Envelope<ReservationDetail>>(`${this.org}/reservations/${encodeURIComponent(id)}`));
  }
  poll(propertyId: string, connectionId: string): Observable<PollResult> {
    return this.data(this.http.post<Envelope<PollResult>>(`${this.conn(propertyId, connectionId)}/poll`, {}));
  }
  importSummary(propertyId: string, connectionId: string): Observable<{ ok: boolean; stored: number; error: string | null }> {
    return this.data(this.http.post<Envelope<{ ok: boolean; stored: number; error: string | null }>>(`${this.conn(propertyId, connectionId)}/import-summary`, {}));
  }
  createTest(propertyId: string, connectionId: string, body: { status: 'new' | 'modified' | 'cancelled'; channelReservationId?: string }) {
    return this.data(
      this.http.post<Envelope<{ result: { ok: boolean; providerCode: number | null; providerMessage: string | null; error: string | null }; poll: PollResult | null }>>(`${this.conn(propertyId, connectionId)}/test`, body),
    );
  }

  syncStatus(propertyId?: string): Observable<SyncStatus[]> {
    return this.data(this.http.get<Envelope<SyncStatus[]>>(`${this.org}/sync-status`, { params: propertyId ? { propertyId } : {} }));
  }
  retryJob(jobId: string): Observable<{ queued: boolean }> {
    return this.data(this.http.post<Envelope<{ queued: boolean }>>(`${this.org}/sync-jobs/${encodeURIComponent(jobId)}/retry`, {}));
  }

  discrepancies(f: { propertyId?: string; status?: string }): Observable<{ items: Discrepancy[]; openBySeverity: Partial<Record<'high' | 'medium' | 'low', number>> }> {
    const params: Record<string, string> = {};
    if (f.propertyId) params['propertyId'] = f.propertyId;
    if (f.status) params['status'] = f.status;
    return this.data(this.http.get<Envelope<{ items: Discrepancy[]; openBySeverity: Partial<Record<'high' | 'medium' | 'low', number>> }>>(`${this.org}/discrepancies`, { params }));
  }
  decide(id: string, decision: 'resolve' | 'ignore' | 'reopen', note?: string): Observable<Discrepancy> {
    return this.data(this.http.post<Envelope<Discrepancy>>(`${this.org}/discrepancies/${encodeURIComponent(id)}/${decision}`, note ? { note } : {}));
  }
}

export interface ReportSummary {
  property: { id: string; name: string; currency: string; timezone: string };
  from: string;
  to: string;
  nights: number;
  includeTest: boolean;
  testBookingsInRange: number;
  otherCurrencyBookings: number;
  totals: {
    roomsInService: number;
    roomNightsAvailable: number;
    roomNightsSold: number;
    occupancyPct: number | null;
    revenue: number;
    adr: number | null;
    revpar: number | null;
    bookingsStaying: number;
    cancellationsStaying: number;
    bookingsReceived: number;
    cancellationsReceived: number;
  };
  daily: { date: string; roomNightsSold: number; occupancyPct: number | null; revenue: number }[];
  byRoomType: { roomTypeId: string | null; name: string; roomsInService: number; roomNightsSold: number; occupancyPct: number | null; revenue: number; adr: number | null }[];
  byChannel: { channel: string; bookings: number; cancellations: number; roomNights: number; revenue: number; sharePct: number | null }[];
}

@Injectable({ providedIn: 'root' })
export class ReportsApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private get org(): string {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return `${API_BASE}/organizations/${org.organizationId}`;
  }
  summary(q: { propertyId: string; from: string; to: string; includeTest: boolean }): Observable<ReportSummary> {
    return this.http.get<{ data: ReportSummary }>(`${this.org}/reports/summary`, { params: { ...q, includeTest: String(q.includeTest) } }).pipe(map((r) => r.data));
  }
  csvUrl(q: { propertyId: string; from: string; to: string; includeTest: boolean }): string {
    const p = new URLSearchParams({ ...q, includeTest: String(q.includeTest) });
    return `${this.org}/reports/summary.csv?${p.toString()}`;
  }
}

export interface ChannelPromotion {
  id: string;
  name: string | null;
  type: string | null;
  active: boolean | null;
  nonRefundable: boolean | null;
  minStayThrough: number | null;
  discount: string | null;
  stayFrom: string | null;
  stayTo: string | null;
  bookFrom: string | null;
  bookTo: string | null;
  roomIds: string[];
  stats: { revenue: string | null; currency: string | null; roomNights: number | null; bookings: number | null; cancellations: number | null };
}

@Injectable({ providedIn: 'root' })
export class PromotionsApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private url(propertyId: string, connectionId: string): string {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return `${API_BASE}/organizations/${org.organizationId}/properties/${encodeURIComponent(propertyId)}/channel-connections/${encodeURIComponent(connectionId)}/promotions`;
  }
  list(propertyId: string, connectionId: string, active: boolean): Observable<ChannelPromotion[]> {
    return this.http.get<{ data: ChannelPromotion[] }>(this.url(propertyId, connectionId), { params: { active: active ? '1' : '0' } }).pipe(map((r) => r.data));
  }
  setActive(propertyId: string, connectionId: string, promotionId: string, active: boolean): Observable<unknown> {
    return this.http.post(`${this.url(propertyId, connectionId)}/${encodeURIComponent(promotionId)}/${active ? 'activate' : 'deactivate'}`, {});
  }
}
