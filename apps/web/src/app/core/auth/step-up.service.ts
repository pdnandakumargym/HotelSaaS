import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Sensitive actions need a recent password (+2FA) confirmation. `run()` performs the action and,
 * if the API answers STEP_UP_REQUIRED, shows the confirmation dialog and retries once.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  private readonly auth = inject(AuthService);
  readonly open = signal(false);
  private resolver: ((ok: boolean) => void) | null = null;

  get needsCode(): boolean {
    return this.auth.user()?.twoFactorEnabled ?? false;
  }

  run<T>(action: () => Observable<T>): Observable<T> {
    return action().pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 403 && (err.error as { error?: { code?: string } })?.error?.code === 'STEP_UP_REQUIRED') {
          return from(this.ask()).pipe(switchMap((ok) => (ok ? action() : throwError(() => err))));
        }
        return throwError(() => err);
      }),
    );
  }

  private ask(): Promise<boolean> {
    this.open.set(true);
    return new Promise((resolve) => (this.resolver = resolve));
  }

  confirm(password: string, code?: string): Observable<unknown> {
    return this.auth.stepUp(password, code);
  }

  finish(ok: boolean): void {
    this.open.set(false);
    this.resolver?.(ok);
    this.resolver = null;
  }
}
