import { provideHttpClient, withXsrfConfiguration } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { OWNER_ME } from '../../../testing/auth-testing';
import { Login } from './login';

describe('Login', () => {
  function setup(returnUrl: string | null = null) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withXsrfConfiguration({ cookieName: 'ss_csrf', headerName: 'X-CSRF-Token' })),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(returnUrl ? { returnUrl } : {}) } } },
      ],
    });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const http = TestBed.inject(HttpTestingController);
    const type = (id: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const submit = async () => {
      el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
    };
    return { fixture, el, type, submit, http, navigate };
  }

  it('validates before calling the API', async () => {
    const { el, submit, http } = setup();
    await submit();
    expect(el.textContent).toContain('Enter a valid email address.');
    http.expectNone('/api/v1/auth/login');
  });

  it('signs in and goes to the dashboard', async () => {
    const { type, submit, http, navigate, fixture } = setup();
    type('email', 'owner@example.test');
    type('password', 'correct horse battery staple');
    await submit();
    const req = http.expectOne('/api/v1/auth/login');
    expect(req.request.body).toEqual({ email: 'owner@example.test', password: 'correct horse battery staple' });
    req.flush({ data: OWNER_ME });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith('/app');
  });

  it('follows a same-app return URL but never an external one', async () => {
    for (const [returnUrl, expected] of [
      ['/app/settings', '/app/settings'],
      ['//evil.example/phish', '/app'],
      ['https://evil.example', '/app'],
    ]) {
      TestBed.resetTestingModule();
      const { type, submit, http, navigate, fixture } = setup(returnUrl);
      type('email', 'owner@example.test');
      type('password', 'pw');
      await submit();
      http.expectOne('/api/v1/auth/login').flush({ data: OWNER_ME });
      await fixture.whenStable();
      expect(navigate).toHaveBeenCalledWith(expected);
    }
  });

  it('routes to the 2FA challenge when a second factor is pending', async () => {
    const { type, submit, http, navigate, fixture } = setup();
    type('email', 'owner@example.test');
    type('password', 'pw');
    await submit();
    http.expectOne('/api/v1/auth/login').flush({ data: { ...OWNER_ME, state: 'mfa_pending', memberships: [] } });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith('/login/2fa');
  });

  it('shows the generic error, clears the password and offers resend for unverified emails', async () => {
    const { el, type, submit, http, fixture } = setup();
    type('email', 'owner@example.test');
    type('password', 'pw');
    await submit();
    http
      .expectOne('/api/v1/auth/login')
      .flush({ error: { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address first.' } }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Verify your email address first.');
    expect(el.textContent).toContain('Send a new verification link');
    expect(el.querySelector<HTMLInputElement>('#password')!.value).toBe('');
  });
});
