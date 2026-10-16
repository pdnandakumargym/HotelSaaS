import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, switchMap, throwError } from 'rxjs';
import { API_BASE } from '../api/api.config';
import { ApiError, toApiError } from '../api/api-error';

export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: { database: { status: 'up' | 'down'; latencyMs: number } };
  timestamp: string;
}

export interface Liveness {
  status: 'ok';
  service: string;
  version: string;
  environment: 'development' | 'test' | 'production';
  uptimeSeconds: number;
  timestamp: string;
}

export type SystemStatus =
  | { state: 'ok' | 'degraded'; liveness: Liveness; readiness: Readiness; checkedAt: Date }
  | { state: 'unreachable'; error: ApiError; checkedAt: Date };

const UNKNOWN_READINESS: Readiness = {
  status: 'not_ready',
  checks: { database: { status: 'down', latencyMs: 0 } },
  timestamp: '',
};

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly http = inject(HttpClient);

  /** Liveness first; if the API is up, readiness (a 503 still carries a body we can show). */
  getSystemStatus(): Observable<SystemStatus> {
    return this.http.get<{ data: Liveness }>(`${API_BASE}/health`).pipe(
      switchMap(({ data: liveness }) =>
        this.http.get<{ data: Readiness }>(`${API_BASE}/health/ready`).pipe(
          map((r) => r.data),
          catchError((err: unknown) => {
            if (err instanceof HttpErrorResponse && err.status === 503) {
              const body = err.error as { data?: Readiness } | null;
              return of(body?.data ?? UNKNOWN_READINESS);
            }
            return throwError(() => err);
          }),
          map(
            (readiness): SystemStatus => ({
              state: readiness.status === 'ready' ? 'ok' : 'degraded',
              liveness,
              readiness,
              checkedAt: new Date(),
            }),
          ),
        ),
      ),
      catchError((err: unknown) => of<SystemStatus>({ state: 'unreachable', error: toApiError(err), checkedAt: new Date() })),
    );
  }
}
