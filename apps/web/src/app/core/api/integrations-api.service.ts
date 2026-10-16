import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_BASE } from './api.config';

export type ReferenceKind = 'account' | 'channels' | 'currencies' | 'price_models';
export const REFERENCE_KINDS: readonly { kind: ReferenceKind; label: string; path: string }[] = [
  { kind: 'account', label: 'Account', path: 'GET /account' },
  { kind: 'channels', label: 'Channels', path: 'GET /channels' },
  { kind: 'currencies', label: 'Currencies', path: 'GET /currencies' },
  { kind: 'price_models', label: 'Price models', path: 'GET /price-model' },
];

export type ConnectionState = 'disabled' | 'not_configured' | 'untested' | 'connected' | 'degraded' | 'failing';
export type CredentialState = 'not_configured' | 'unverified' | 'valid' | 'rejected';

export interface ProviderConfig {
  provider: string;
  displayName: string;
  enabled: boolean;
  environment: 'sandbox' | 'production';
  baseUrl: string;
  credentialsConfigured: boolean;
}

export interface IntegrationHealth {
  connection: ConnectionState;
  credentials: CredentialState;
  window: { hours: number; calls: number; failures: number; errorRate: number | null; p50Ms: number | null; p95Ms: number | null };
  lastSuccessAt: string | null;
  lastFailure: { at: string; outcome: string; httpStatus: number | null; message: string | null } | null;
}

export interface CallResult {
  ok: boolean;
  operation: string;
  outcome: string;
  httpStatus: number | null;
  durationMs: number;
  attempts: number;
  providerCode: number | null;
  providerMessage: string | null;
  error: { code: string; message: string } | null;
  stored?: { fetchedAt: string; itemCount: number | null } | null;
}

export interface CallLog {
  id: string;
  environment: string;
  operation: string;
  httpMethod: string;
  path: string;
  httpStatus: number | null;
  outcome: string;
  durationMs: number;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  providerCode: number | null;
  providerMessage: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface ReferenceData {
  kind: ReferenceKind;
  environment: string;
  payload: unknown;
  itemCount: number | null;
  fetchedAt: string;
}

export type OwnerProviderState = 'available' | 'unavailable' | 'not_verified' | 'not_configured';
export interface OwnerChannels {
  provider: { displayName: string; environment: string; state: OwnerProviderState };
  availableChannels: { items: unknown; itemCount: number | null; fetchedAt: string } | null;
  plan: { code: string; maxChannels: number; channelsInUse: number };
  properties: {
    id: string;
    name: string;
    status: string;
    connections: { id: string; channelId: number; channelName: string; channelPropertyId: string; status: import('./channel-api.service').ConnectionStatus; environment: string; lastError: string | null; mappedRooms: number }[];
  }[];
  mapping: { available: boolean; channelOptions: { channelId: number; name: string }[] };
}

interface Envelope<T> {
  data: T;
}

@Injectable({ providedIn: 'root' })
export class IntegrationsApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly admin = `${API_BASE}/admin/integrations/zodomus`;

  status(): Observable<{ config: ProviderConfig; health: IntegrationHealth }> {
    return this.http.get<Envelope<{ config: ProviderConfig; health: IntegrationHealth }>>(this.admin).pipe(map((r) => r.data));
  }
  testConnection(): Observable<CallResult> {
    return this.http.post<Envelope<CallResult>>(`${this.admin}/test`, {}).pipe(map((r) => r.data));
  }
  calls(limit = 50): Observable<CallLog[]> {
    return this.http.get<Envelope<CallLog[]>>(`${this.admin}/calls`, { params: { limit } }).pipe(map((r) => r.data));
  }
  reference(kind: ReferenceKind): Observable<ReferenceData | null> {
    return this.http.get<Envelope<ReferenceData | null>>(`${this.admin}/reference/${kind}`).pipe(map((r) => r.data));
  }
  refresh(kind: ReferenceKind): Observable<CallResult> {
    return this.http.post<Envelope<CallResult>>(`${this.admin}/reference/${kind}/refresh`, {}).pipe(map((r) => r.data));
  }

  ownerChannels(): Observable<OwnerChannels> {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return this.http.get<Envelope<OwnerChannels>>(`${API_BASE}/organizations/${org.organizationId}/channels`).pipe(map((r) => r.data));
  }
}

export const CONNECTION_LABEL: Record<ConnectionState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  connected: { label: 'Connected', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  failing: { label: 'Failing', tone: 'danger' },
  untested: { label: 'Not tested yet', tone: 'info' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
};
export const CREDENTIAL_LABEL: Record<CredentialState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  valid: { label: 'Valid', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  unverified: { label: 'Not verified', tone: 'info' },
  not_configured: { label: 'Missing', tone: 'neutral' },
};
