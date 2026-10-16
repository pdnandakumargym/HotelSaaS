import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { OrgRole } from '../auth/auth.models';
import { AuthService } from '../auth/auth.service';
import { API_BASE } from './api.config';

export type PropertyType = 'HOTEL' | 'HOMESTAY' | 'VILLA' | 'BUNGALOW' | 'RESORT' | 'APARTMENT' | 'OTHER';
export type PropertyStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE';

export interface Property {
  id: string;
  name: string;
  propertyType: PropertyType;
  status: PropertyStatus;
  timezone: string;
  currency: string;
  countryCode: string;
  state: string | null;
  city: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  description: string | null;
  starRating: number | null;
  contactEmail: string | null;
  contactPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  cancellationPolicy: string | null;
  houseRules: string | null;
  amenities: string[];
  roomTypeCount?: number;
  roomCount?: number;
  roomTypes?: RoomType[];
}

export interface RoomType {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  description: string | null;
  baseOccupancy: number;
  maxAdults: number;
  maxChildren: number;
  maxOccupancy: number;
  bedConfiguration: string | null;
  sizeSqm: number | null;
  amenities: string[];
  status: 'ACTIVE' | 'INACTIVE';
  sortOrder: number;
  roomCount?: number;
}

export interface Room {
  id: string;
  name: string;
  floor: string | null;
  status: 'AVAILABLE' | 'OUT_OF_SERVICE';
  notes: string | null;
  roomTypeId: string;
  roomType: { id: string; name: string; code: string };
}

export interface Amenity {
  code: string;
  label: string;
  group: string;
  scope: 'property' | 'room' | 'both';
}

export interface Member {
  membershipId: string;
  role: OrgRole;
  displayName: string;
  email: string;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
  isMe: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

export interface Plan {
  code: string;
  name: string;
  maxProperties: number;
  maxUsers: number;
  maxChannels: number;
  priceMonthlyMinor: number;
  currency: string;
  trialDays?: number;
}

export interface Subscription {
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  plan: Plan;
  usage: { properties: number; members: number; pendingInvitations: number; users: number; channels: number };
  canManageBilling: boolean;
}

export interface SupportRequest {
  id: string;
  reason: string;
  durationMinutes: number;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'REVOKED';
  expiresAt: string | null;
  createdAt: string;
  active: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  defaultCurrency: string;
  twoFactorRequired: boolean;
}

interface Envelope<T> {
  data: T;
}

/** Tenant API for the current organization. The API authorizes every call; nothing here is trusted. */
@Injectable({ providedIn: 'root' })
export class OrgApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private get base(): string {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return `${API_BASE}/organizations/${org.organizationId}`;
  }

  private get<T>(path: string, params?: HttpParams): Observable<T> {
    return this.http.get<Envelope<T>>(`${this.base}${path}`, { params }).pipe(map((r) => r.data));
  }
  private post<T>(path: string, body: unknown = {}): Observable<T> {
    return this.http.post<Envelope<T>>(`${this.base}${path}`, body).pipe(map((r) => r.data));
  }
  private patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<Envelope<T>>(`${this.base}${path}`, body).pipe(map((r) => r.data));
  }
  private del<T>(path: string): Observable<T> {
    return this.http.delete<Envelope<T>>(`${this.base}${path}`).pipe(map((r) => r.data));
  }

  amenities(): Observable<Amenity[]> {
    return this.http.get<Envelope<Amenity[]>>(`${API_BASE}/amenities`).pipe(map((r) => r.data));
  }
  plans(): Observable<Plan[]> {
    return this.http.get<Envelope<Plan[]>>(`${API_BASE}/plans`).pipe(map((r) => r.data));
  }

  organization(): Observable<Organization> {
    return this.get('');
  }
  updateOrganization(body: Partial<Pick<Organization, 'name' | 'defaultCurrency'>>): Observable<Organization> {
    return this.patch('', body);
  }
  setTwoFactorPolicy(twoFactorRequired: boolean): Observable<unknown> {
    return this.patch('/security', { twoFactorRequired });
  }

  properties(): Observable<Property[]> {
    return this.get('/properties', new HttpParams().set('pageSize', 100));
  }
  property(id: string): Observable<Property> {
    return this.get(`/properties/${id}`);
  }
  createProperty(body: Partial<Property>): Observable<Property> {
    return this.post('/properties', body);
  }
  updateProperty(id: string, body: Partial<Property>): Observable<Property> {
    return this.patch(`/properties/${id}`, body);
  }
  deleteProperty(id: string): Observable<unknown> {
    return this.del(`/properties/${id}`);
  }

  roomTypes(propertyId: string): Observable<RoomType[]> {
    return this.get(`/properties/${propertyId}/room-types`);
  }
  createRoomType(propertyId: string, body: Partial<RoomType>): Observable<RoomType> {
    return this.post(`/properties/${propertyId}/room-types`, body);
  }
  updateRoomType(propertyId: string, id: string, body: Partial<RoomType>): Observable<RoomType> {
    return this.patch(`/properties/${propertyId}/room-types/${id}`, body);
  }
  deleteRoomType(propertyId: string, id: string): Observable<unknown> {
    return this.del(`/properties/${propertyId}/room-types/${id}`);
  }

  rooms(propertyId: string): Observable<Room[]> {
    return this.get(`/properties/${propertyId}/rooms`);
  }
  createRooms(propertyId: string, roomTypeId: string, names: string[], floor?: string): Observable<{ created: number }> {
    return this.post(`/properties/${propertyId}/rooms/bulk`, { roomTypeId, names, ...(floor ? { floor } : {}) });
  }
  updateRoom(propertyId: string, id: string, body: Partial<Room>): Observable<Room> {
    return this.patch(`/properties/${propertyId}/rooms/${id}`, body);
  }
  deleteRoom(propertyId: string, id: string): Observable<unknown> {
    return this.del(`/properties/${propertyId}/rooms/${id}`);
  }

  members(): Observable<Member[]> {
    return this.get('/members');
  }
  changeRole(membershipId: string, role: OrgRole): Observable<unknown> {
    return this.patch(`/members/${membershipId}`, { role });
  }
  removeMember(membershipId: string): Observable<unknown> {
    return this.del(`/members/${membershipId}`);
  }
  invitations(): Observable<Invitation[]> {
    return this.get('/invitations');
  }
  invite(email: string, role: OrgRole): Observable<Invitation> {
    return this.post('/invitations', { email, role });
  }
  resendInvitation(id: string): Observable<unknown> {
    return this.post(`/invitations/${id}/resend`);
  }
  revokeInvitation(id: string): Observable<unknown> {
    return this.del(`/invitations/${id}`);
  }

  subscription(): Observable<Subscription> {
    return this.get('/subscription');
  }

  supportRequests(): Observable<SupportRequest[]> {
    return this.get('/support-access');
  }
  decideSupport(id: string, decision: 'approve' | 'deny' | 'revoke'): Observable<unknown> {
    return this.post(`/support-access/${id}/${decision}`);
  }
}

/** Parses "101-110, 201, 202" into room names. Ranges keep zero padding ("01-03" -> 01, 02, 03). */
export function expandRoomNames(input: string, max = 200): string[] {
  const out: string[] = [];
  for (const part of input.split(/[,\n]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]*)(\d+)\s*-\s*\1?(\d+)$/.exec(part);
    if (m) {
      const [, prefix = '', fromStr = '', toStr = ''] = m;
      const from = Number(fromStr);
      const to = Number(toStr);
      if (to < from || to - from > max) throw new Error(`Invalid range "${part}"`);
      for (let n = from; n <= to; n++) out.push(prefix + String(n).padStart(fromStr.length, '0'));
    } else out.push(part);
    if (out.length > max) throw new Error(`At most ${max} rooms at once`);
  }
  return out;
}

export const PROPERTY_TYPES: { value: PropertyType; label: string }[] = [
  { value: 'HOTEL', label: 'Hotel' },
  { value: 'HOMESTAY', label: 'Homestay' },
  { value: 'VILLA', label: 'Villa' },
  { value: 'BUNGALOW', label: 'Bungalow' },
  { value: 'RESORT', label: 'Resort' },
  { value: 'APARTMENT', label: 'Apartment' },
  { value: 'OTHER', label: 'Other' },
];

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}
