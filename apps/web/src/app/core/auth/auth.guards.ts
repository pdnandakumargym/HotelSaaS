import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Route guards are a user-experience feature only. Every protected operation is
 * authorized by the API; these guards just send people to the right screen.
 */
function redirectFor(state: string, router: Router, returnUrl?: string): UrlTree | null {
  switch (state) {
    case 'anonymous':
      return router.createUrlTree(['/login'], returnUrl ? { queryParams: { returnUrl } } : {});
    case 'mfa_pending':
      return router.createUrlTree(['/login/2fa']);
    case 'mfa_enrollment_required':
      return router.createUrlTree(['/security/two-factor-setup']);
    default:
      return null;
  }
}

export const authGuard: CanActivateFn = async (_route, routerState) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.loaded()) await auth.refresh();
  return redirectFor(auth.state(), router, routerState.url) ?? true;
};

export const adminGuard: CanActivateFn = async (_route, routerState) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.loaded()) await auth.refresh();
  const redirect = redirectFor(auth.state(), router, routerState.url);
  if (redirect) return redirect;
  return auth.isPlatformAdmin() ? true : router.createUrlTree(['/app']);
};

/** For login/register pages: signed-in users go to their home. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.loaded()) await auth.refresh();
  if (auth.state() === 'authenticated') return router.createUrlTree([auth.isPlatformAdmin() && auth.memberships().length === 0 ? '/admin' : '/app']);
  return true;
};

export const mfaPendingGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.loaded()) await auth.refresh();
  return auth.state() === 'mfa_pending' ? true : (redirectFor(auth.state(), router) ?? router.createUrlTree(['/app']));
};

/** Two-factor setup: for fully signed-in users and for users who must enroll. */
export const enrollmentGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.loaded()) await auth.refresh();
  const s = auth.state();
  if (s === 'authenticated' || s === 'mfa_enrollment_required') return true;
  return redirectFor(s, router) ?? router.createUrlTree(['/login']);
};

/** Where to go after a successful sign-in. */
export function homeFor(auth: AuthService): string {
  if (auth.state() === 'mfa_pending') return '/login/2fa';
  if (auth.state() === 'mfa_enrollment_required') return '/security/two-factor-setup';
  return auth.memberships().length === 0 && auth.isPlatformAdmin() ? '/admin' : '/app';
}
