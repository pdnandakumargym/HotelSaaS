import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../auth/auth.service';

/**
 * Same-origin API calls only: sends cookies (the HttpOnly session cookie) and asks for JSON.
 * Never attaches credentials to third-party URLs. The CSRF header is added by Angular's
 * XSRF support (cookie ss_csrf -> header X-CSRF-Token) for mutating requests.
 * A 401 on a protected call means the session ended: return to sign-in.
 */
export const apiInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req.clone({ withCredentials: true, setHeaders: { Accept: 'application/json' } })).pipe(
    catchError((err: unknown) => {
      const code = err instanceof HttpErrorResponse ? (err.error as { error?: { code?: string } } | null)?.error?.code : undefined;
      if (code === 'UNAUTHENTICATED' && !req.url.includes('/auth/')) {
        auth.markSignedOut();
        void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => err);
    }),
  );
};
