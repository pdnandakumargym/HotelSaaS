import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of, tap } from 'rxjs';
import { API_BASE } from '../api/api.config';
import { Me, Membership, SessionInfo, TotpSetup } from './auth.models';

interface Envelope<T> {
  data: T;
}

/**
 * Client-side view of the server session. The session itself lives in an HttpOnly cookie the
 * app cannot read; this service only mirrors /auth/me. Authorization is enforced by the API.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly url = `${API_BASE}/auth`;

  readonly me = signal<Me>({ state: 'anonymous' });
  readonly loaded = signal(false);
  readonly state = computed(() => this.me().state);
  readonly user = computed(() => this.me().user ?? null);
  readonly memberships = computed(() => this.me().memberships ?? []);
  readonly currentOrg = computed<Membership | null>(() => this.memberships()[0] ?? null);
  readonly isPlatformAdmin = computed(() => (this.me().platformPermissions ?? []).includes('admin.access'));

  hasOrgPermission(permission: string): boolean {
    return this.currentOrg()?.permissions.includes(permission) ?? false;
  }

  hasPlatformPermission(permission: string): boolean {
    return (this.me().platformPermissions ?? []).includes(permission);
  }

  /** Loads /auth/me. Never throws: an unreachable API is treated as signed out. */
  refresh(): Promise<Me> {
    return firstValueFrom(
      this.http.get<Envelope<Me>>(`${this.url}/me`).pipe(
        map((r) => r.data),
        catchError(() => of<Me>({ state: 'anonymous' })),
        tap((me) => {
          this.me.set(me);
          this.loaded.set(true);
        }),
      ),
    );
  }

  markSignedOut(): void {
    this.me.set({ state: 'anonymous' });
  }

  private setMe = (r: Envelope<Me>) => this.me.set(r.data);

  login(email: string, password: string): Observable<Me> {
    return this.http.post<Envelope<Me>>(`${this.url}/login`, { email, password }).pipe(tap(this.setMe), map((r) => r.data));
  }

  verifySecondFactor(body: { code?: string; recoveryCode?: string }): Observable<Me> {
    return this.http.post<Envelope<Me>>(`${this.url}/2fa/verify`, body).pipe(tap(this.setMe), map((r) => r.data));
  }

  logout(): Observable<void> {
    return this.http.post(`${this.url}/logout`, {}).pipe(
      map(() => undefined),
      catchError(() => of(undefined)),
      tap(() => this.markSignedOut()),
    );
  }

  register(body: { email: string; password: string; displayName: string; organizationName: string }): Observable<unknown> {
    return this.http.post(`${this.url}/register`, body);
  }

  verifyEmail(token: string): Observable<unknown> {
    return this.http.post(`${this.url}/verify-email`, { token });
  }

  resendVerification(email: string): Observable<unknown> {
    return this.http.post(`${this.url}/verify-email/resend`, { email });
  }

  forgotPassword(email: string): Observable<unknown> {
    return this.http.post(`${this.url}/password/forgot`, { email });
  }

  resetPassword(body: { token: string; password: string; code?: string; recoveryCode?: string }): Observable<unknown> {
    return this.http.post(`${this.url}/password/reset`, body);
  }

  changePassword(newPassword: string): Observable<unknown> {
    return this.http.post(`${this.url}/password/change`, { newPassword });
  }

  stepUp(password: string, code?: string): Observable<unknown> {
    return this.http.post(`${this.url}/step-up`, code ? { password, code } : { password });
  }

  setupTotp(): Observable<TotpSetup> {
    return this.http.post<Envelope<TotpSetup>>(`${this.url}/2fa/setup`, {}).pipe(map((r) => r.data));
  }

  enableTotp(code: string): Observable<string[]> {
    return this.http.post<Envelope<{ recoveryCodes: string[] }>>(`${this.url}/2fa/enable`, { code }).pipe(map((r) => r.data.recoveryCodes));
  }

  disableTotp(): Observable<unknown> {
    return this.http.post(`${this.url}/2fa/disable`, {});
  }

  regenerateRecoveryCodes(): Observable<string[]> {
    return this.http.post<Envelope<{ recoveryCodes: string[] }>>(`${this.url}/2fa/recovery-codes`, {}).pipe(map((r) => r.data.recoveryCodes));
  }

  twoFactorStatus(): Observable<{ enabled: boolean; required: boolean; recoveryCodesRemaining: number }> {
    return this.http.get<Envelope<{ enabled: boolean; required: boolean; recoveryCodesRemaining: number }>>(`${this.url}/2fa/status`).pipe(map((r) => r.data));
  }

  requestEmailChange(email: string): Observable<unknown> {
    return this.http.post(`${this.url}/email/change`, { email });
  }

  sessions(): Observable<SessionInfo[]> {
    return this.http.get<Envelope<SessionInfo[]>>(`${this.url}/sessions`).pipe(map((r) => r.data));
  }

  revokeSession(id: string): Observable<unknown> {
    return this.http.delete(`${this.url}/sessions/${encodeURIComponent(id)}`);
  }

  revokeOtherSessions(): Observable<{ count: number }> {
    return this.http.post<Envelope<{ count: number }>>(`${this.url}/sessions/revoke-others`, {}).pipe(map((r) => r.data));
  }
}
