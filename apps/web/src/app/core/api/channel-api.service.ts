import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_BASE } from './api.config';

export type MealPlan = 'ROOM_ONLY' | 'BREAKFAST' | 'HALF_BOARD' | 'FULL_BOARD' | 'ALL_INCLUSIVE';
export const MEAL_PLANS: readonly { value: MealPlan; label: string }[] = [
  { value: 'ROOM_ONLY', label: 'Room only' },
  { value: 'BREAKFAST', label: 'Breakfast included' },
  { value: 'HALF_BOARD', label: 'Half board' },
  { value: 'FULL_BOARD', label: 'Full board' },
  { value: 'ALL_INCLUSIVE', label: 'All inclusive' },
];

export interface RatePlan {
  id: string;
  name: string;
  code: string;
  description: string | null;
  mealPlan: MealPlan | null;
  singleOccupancyDiscountPct: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  sortOrder: number;
}

export interface CalendarDay {
  date: string;
  available: number;
  override: number | null;
  stopSell: boolean;
  /** Rooms booked through channels on this night (already subtracted from `available`). */
  booked: number;
}
export interface RateDayView {
  date: string;
  price: number | null;
  priceSingle: number | null;
  minStay: number | null;
  maxStay: number | null;
  closed: boolean;
  closedOnArrival: boolean;
  closedOnDeparture: boolean;
}
export interface Calendar {
  from: string;
  to: string;
  dates: string[];
  currency: string;
  timezone: string;
  ratePlans: { id: string; name: string; code: string }[];
  roomTypes: { id: string; name: string; code: string; maxOccupancy: number; roomsInService: number; days: CalendarDay[]; rates: { ratePlanId: string; days: RateDayView[] }[] }[];
}

export interface BulkUpdate {
  from: string;
  to: string;
  weekdays?: number[];
  roomTypeIds: string[];
  ratePlanIds?: string[];
  availability?: { available?: number | null; stopSell?: boolean };
  rates?: { price?: number | null; priceSingle?: number | null; minStay?: number | null; maxStay?: number | null; closed?: boolean; closedOnArrival?: boolean; closedOnDeparture?: boolean };
}

export interface ChannelOption {
  channelId: number;
  name: string;
  priceModels: { id: number; name: string; recommended?: boolean }[];
}
export interface ProviderOption {
  id: string;
  displayName: string;
  ready: boolean;
  environment: string;
  channels: ChannelOption[];
}
/** Top-level fields describe Zodomus (as before); `providers` lists every channel manager. */
export interface ChannelOptions {
  ready: boolean;
  environment: string;
  channels: ChannelOption[];
  providers?: ProviderOption[];
}
export interface ChannelRoom {
  id: string;
  name: string;
  rates: { id: string; name: string; active: boolean | null; maxPersons: number | null }[];
}
export type ConnectionStatus = 'DRAFT' | 'ACTIVATED' | 'ACTIVE' | 'ERROR' | 'DISCONNECTED';
export interface ChannelConnection {
  id: string;
  propertyId: string;
  /** Channel manager ("zodomus" or "beds24"). */
  provider?: string;
  environment: string;
  channelId: number;
  channelName: string;
  channelPropertyId: string;
  priceModelId: number;
  currency: string;
  status: ConnectionStatus;
  lastError: string | null;
  lastCheckAt: string | null;
  lastCheckMessage: string | null;
  channelRooms: ChannelRoom[] | null;
  channelRoomsFetchedAt: string | null;
  activatedAt: string | null;
  roomsActivatedAt: string | null;
  roomMappings: { id: string; roomTypeId: string; channelRoomId: string; channelRoomName: string; rates: { ratePlanId: string; channelRateId: string; channelRateName: string }[] }[];
}
export interface CallSummary {
  ok: boolean;
  outcome: string;
  httpStatus: number | null;
  providerCode: number | null;
  providerMessage: string | null;
  error: string | null;
}
export interface SyncJob {
  id: string;
  kind: 'AVAILABILITY' | 'RATES' | 'RATES_DERIVED';
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  roomTypeId: string | null;
  ratePlanId: string | null;
  dateFrom: string;
  dateTo: string;
  attempts: number;
  callsMade: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface MappingInput {
  rooms: { channelRoomId: string; roomTypeId: string; rates: { channelRateId: string; ratePlanId: string }[] }[];
}

interface Envelope<T> {
  data: T;
}

@Injectable({ providedIn: 'root' })
export class ChannelApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private get org(): string {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return `${API_BASE}/organizations/${org.organizationId}`;
  }
  private p(propertyId: string): string {
    return `${this.org}/properties/${encodeURIComponent(propertyId)}`;
  }
  private data<T>(o: Observable<Envelope<T>>): Observable<T> {
    return o.pipe(map((r) => r.data));
  }

  // rate plans
  ratePlans(propertyId: string): Observable<RatePlan[]> {
    return this.data(this.http.get<Envelope<RatePlan[]>>(`${this.p(propertyId)}/rate-plans`));
  }
  createRatePlan(propertyId: string, body: Partial<RatePlan>): Observable<RatePlan> {
    return this.data(this.http.post<Envelope<RatePlan>>(`${this.p(propertyId)}/rate-plans`, body));
  }
  updateRatePlan(propertyId: string, id: string, body: Partial<RatePlan>): Observable<RatePlan> {
    return this.data(this.http.patch<Envelope<RatePlan>>(`${this.p(propertyId)}/rate-plans/${id}`, body));
  }
  deleteRatePlan(propertyId: string, id: string): Observable<unknown> {
    return this.http.delete(`${this.p(propertyId)}/rate-plans/${id}`);
  }

  // calendar
  calendar(propertyId: string, from: string | null, days: number): Observable<Calendar> {
    const params: Record<string, string | number> = { days };
    if (from) params['from'] = from;
    return this.data(this.http.get<Envelope<Calendar>>(`${this.p(propertyId)}/calendar`, { params }));
  }
  updateCalendar(propertyId: string, body: BulkUpdate): Observable<{ dates: number; changed: number; syncJobsQueued: number }> {
    return this.data(this.http.put<Envelope<{ dates: number; changed: number; syncJobsQueued: number }>>(`${this.p(propertyId)}/calendar`, body));
  }

  // channel connections
  options(): Observable<ChannelOptions> {
    return this.data(this.http.get<Envelope<ChannelOptions>>(`${this.org}/channel-options`));
  }
  connections(propertyId: string): Observable<ChannelConnection[]> {
    return this.data(this.http.get<Envelope<ChannelConnection[]>>(`${this.p(propertyId)}/channel-connections`));
  }
  connect(propertyId: string, body: { channelId: number; channelPropertyId: string; priceModelId: number; provider?: string }): Observable<{ connection: ChannelConnection; result: CallSummary }> {
    return this.data(this.http.post<Envelope<{ connection: ChannelConnection; result: CallSummary }>>(`${this.p(propertyId)}/channel-connections`, body));
  }
  activate(propertyId: string, id: string): Observable<{ connection: ChannelConnection; result: CallSummary }> {
    return this.data(this.http.post<Envelope<{ connection: ChannelConnection; result: CallSummary }>>(`${this.p(propertyId)}/channel-connections/${id}/activate`, {}));
  }
  loadRoomRates(propertyId: string, id: string): Observable<{ connection: ChannelConnection; result: CallSummary }> {
    return this.data(this.http.post<Envelope<{ connection: ChannelConnection; result: CallSummary }>>(`${this.p(propertyId)}/channel-connections/${id}/room-rates`, {}));
  }
  saveMapping(propertyId: string, id: string, body: MappingInput): Observable<{ connection: ChannelConnection; steps: { step: string; result: CallSummary }[]; syncJobsQueued: number }> {
    return this.data(this.http.put<Envelope<{ connection: ChannelConnection; steps: { step: string; result: CallSummary }[]; syncJobsQueued: number }>>(`${this.p(propertyId)}/channel-connections/${id}/mapping`, body));
  }
  check(propertyId: string, id: string): Observable<{ connection: ChannelConnection; result: CallSummary; syncJobsQueued: number }> {
    return this.data(this.http.post<Envelope<{ connection: ChannelConnection; result: CallSummary; syncJobsQueued: number }>>(`${this.p(propertyId)}/channel-connections/${id}/check`, {}));
  }
  resync(propertyId: string, id: string): Observable<{ syncJobsQueued: number }> {
    return this.data(this.http.post<Envelope<{ syncJobsQueued: number }>>(`${this.p(propertyId)}/channel-connections/${id}/sync`, {}));
  }
  jobs(propertyId: string, id: string): Observable<SyncJob[]> {
    return this.data(this.http.get<Envelope<SyncJob[]>>(`${this.p(propertyId)}/channel-connections/${id}/jobs`));
  }
  disconnect(propertyId: string, id: string): Observable<{ connection: ChannelConnection }> {
    return this.data(this.http.delete<Envelope<{ connection: ChannelConnection }>>(`${this.p(propertyId)}/channel-connections/${id}`));
  }
}

export const CONNECTION_STATUS: Record<ConnectionStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  DRAFT: { label: 'Not activated', tone: 'warning' },
  ACTIVATED: { label: 'Activated · map rooms', tone: 'info' },
  ACTIVE: { label: 'Connected', tone: 'success' },
  ERROR: { label: 'Needs attention', tone: 'danger' },
  DISCONNECTED: { label: 'Disconnected', tone: 'neutral' },
};
