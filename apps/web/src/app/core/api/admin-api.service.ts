import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE } from './api.config';

export interface Page<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}

export interface AdminOrganization {
  id: string;
  name: string;
  slug: string;
  status: string;
  twoFactorRequired: boolean;
  createdAt: string;
  propertyCount: number;
  memberCount: number;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  platformRole: string | null;
  emailVerifiedAt: string | null;
  twoFactorEnabled: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  organizationCount: number;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorType: string;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface AdminOrgDetail {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  defaultCurrency: string;
  twoFactorRequired: boolean;
  createdAt: string;
  subscription: { status: string; trialEndsAt: string | null; plan: { code: string; name: string; maxProperties: number; maxUsers: number; maxChannels: number } };
  usage: { properties: number; members: number; pendingInvitations: number; users: number; channels: number };
  members: { role: string; joinedAt: string; userId: string; displayName: string; email: string; twoFactorEnabled: boolean; lastLoginAt: string | null }[];
  properties: { id: string; name: string; propertyType: string; status: string; city: string | null; countryCode: string; roomTypeCount: number; roomCount: number }[];
  recentEvents: { id: string; action: string; actorType: string; createdAt: string }[];
}

export interface AdminProperty {
  id: string;
  name: string;
  propertyType: string;
  status: string;
  city: string | null;
  countryCode: string;
  createdAt: string;
  organization: { id: string; name: string };
  roomTypeCount: number;
  roomCount: number;
}

export interface AdminPlan {
  id: string;
  code: string;
  name: string;
  maxProperties: number;
  maxUsers: number;
  maxChannels: number;
  priceMonthlyMinor: number;
  currency: string;
  trialDays: number;
  isActive: boolean;
}

export interface AdminSupportRequest {
  id: string;
  organizationId: string;
  organizationName: string;
  reason: string;
  durationMinutes: number;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'REVOKED';
  expiresAt: string | null;
  createdAt: string;
  active: boolean;
}

@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${API_BASE}/admin`;

  private params(page: number, q?: string): HttpParams {
    let p = new HttpParams().set('page', page).set('pageSize', 25);
    if (q) p = p.set('q', q);
    return p;
  }

  overview(): Observable<{ data: { organizations: number; properties: number; users: number; lockedUsers: number } }> {
    return this.http.get<{ data: { organizations: number; properties: number; users: number; lockedUsers: number } }>(`${this.url}/overview`);
  }
  organizations(page = 1, q?: string): Observable<Page<AdminOrganization>> {
    return this.http.get<Page<AdminOrganization>>(`${this.url}/organizations`, { params: this.params(page, q) });
  }
  users(page = 1, q?: string): Observable<Page<AdminUser>> {
    return this.http.get<Page<AdminUser>>(`${this.url}/users`, { params: this.params(page, q) });
  }
  unlockUser(id: string): Observable<unknown> {
    return this.http.post(`${this.url}/users/${encodeURIComponent(id)}/unlock`, {});
  }
  organization(id: string): Observable<{ data: AdminOrgDetail }> {
    return this.http.get<{ data: AdminOrgDetail }>(`${this.url}/organizations/${encodeURIComponent(id)}`);
  }
  setOrganizationStatus(id: string, status: 'ACTIVE' | 'SUSPENDED', reason: string): Observable<unknown> {
    return this.http.patch(`${this.url}/organizations/${encodeURIComponent(id)}/status`, { status, reason });
  }
  setSubscription(id: string, planCode: string): Observable<unknown> {
    return this.http.patch(`${this.url}/organizations/${encodeURIComponent(id)}/subscription`, { planCode });
  }
  properties(page = 1, q?: string): Observable<Page<AdminProperty>> {
    return this.http.get<Page<AdminProperty>>(`${this.url}/properties`, { params: this.params(page, q) });
  }
  plans(): Observable<{ data: AdminPlan[] }> {
    return this.http.get<{ data: AdminPlan[] }>(`${this.url}/plans`);
  }
  requestSupport(organizationId: string, reason: string, durationMinutes: number): Observable<unknown> {
    return this.http.post(`${this.url}/support-access`, { organizationId, reason, durationMinutes });
  }
  supportRequests(): Observable<{ data: AdminSupportRequest[] }> {
    return this.http.get<{ data: AdminSupportRequest[] }>(`${this.url}/support-access`);
  }
  supportProperties(requestId: string): Observable<{ data: { id: string; name: string; propertyType: string; city: string | null; roomTypes: { id: string; name: string; code: string; maxOccupancy: number; _count: { rooms: number } }[] }[]; meta: { accessExpiresAt: string } }> {
    return this.http.get<{ data: { id: string; name: string; propertyType: string; city: string | null; roomTypes: { id: string; name: string; code: string; maxOccupancy: number; _count: { rooms: number } }[] }[]; meta: { accessExpiresAt: string } }>(
      `${this.url}/support-access/${encodeURIComponent(requestId)}/properties`,
    );
  }
  auditEvents(page = 1, q?: string): Observable<Page<AuditEvent>> {
    return this.http.get<Page<AuditEvent>>(`${this.url}/audit-events`, { params: this.params(page, q) });
  }
}
