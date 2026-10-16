import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { ADMIN_ME, OWNER_ME, setAuth } from './testing/auth-testing';

describe('routing and guards', () => {
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting()],
    });
    harness = await RouterTestingHarness.create();
  });

  const text = () => (harness.routeNativeElement?.ownerDocument.body.textContent ?? '').replace(/\s+/g, ' ');
  const url = () => TestBed.inject(Router).url;
  const navLinks = () => harness.routeNativeElement!.ownerDocument.querySelectorAll('aside nav a').length;

  it('sends anonymous visitors to sign-in with a return URL', async () => {
    setAuth({ state: 'anonymous' });
    await harness.navigateByUrl('/app/dashboard');
    expect(url()).toBe('/login?returnUrl=%2Fapp%2Fdashboard');
    expect(text()).toContain('Welcome back');
  });

  it('shows the owner dashboard with real account data', async () => {
    setAuth(OWNER_ME);
    await harness.navigateByUrl('/');
    expect(text()).toContain('Welcome, Asha');
    expect(text()).toContain('Asha Homestays');
    expect(navLinks()).toBe(16);
  });

  it('sends users with a pending second factor to the 2FA challenge', async () => {
    setAuth({ ...OWNER_ME, state: 'mfa_pending', memberships: [] });
    await harness.navigateByUrl('/app');
    expect(url()).toBe('/login/2fa');
  });

  it('sends users who must enroll to two-factor setup', async () => {
    setAuth({ ...ADMIN_ME, state: 'mfa_enrollment_required' });
    await harness.navigateByUrl('/admin');
    expect(url()).toBe('/security/two-factor-setup');
  });

  it('keeps non-admins out of the admin portal (UX guard; the API enforces it)', async () => {
    setAuth(OWNER_ME);
    await harness.navigateByUrl('/admin/overview');
    expect(url()).toBe('/app/dashboard');
  });

  it('opens the admin portal for platform admins', async () => {
    setAuth(ADMIN_ME);
    await harness.navigateByUrl('/admin');
    expect(text()).toContain('Platform overview');
    expect(navLinks()).toBe(12);
  });

  it('hides admin items the user has no permission for', async () => {
    setAuth({ ...ADMIN_ME, user: { ...ADMIN_ME.user!, platformRole: 'PLATFORM_SUPPORT' }, platformPermissions: ['admin.access', 'admin.org.read', 'admin.user.read', 'admin.support.request', 'admin.integration.read'] });
    await harness.navigateByUrl('/admin');
    expect(navLinks()).toBe(11);
    expect(text()).not.toContain('Security & Audit');
  });

  it('redirects signed-in users away from the login page', async () => {
    setAuth(OWNER_ME);
    await harness.navigateByUrl('/login');
    expect(url()).toBe('/app/dashboard');
  });

  it('shows an honest placeholder for planned modules', async () => {
    setAuth(OWNER_ME);
    await harness.navigateByUrl('/app/bookings');
    expect(text()).toContain('Planned · Milestone 6');
  });

  it('shows not found for unknown URLs', async () => {
    setAuth({ state: 'anonymous' });
    await harness.navigateByUrl('/definitely/not/here');
    expect(text()).toContain('Page not found');
  });
});
