import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { OWNER_ME } from '../../../testing/auth-testing';
import { TwoFactorChallenge } from './two-factor-challenge';

describe('TwoFactorChallenge', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(TwoFactorChallenge);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement, http: TestBed.inject(HttpTestingController), navigate };
  }

  function type(el: HTMLElement, value: string) {
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('submits a 6-digit code and continues', async () => {
    const { fixture, el, http, navigate } = setup();
    type(el, '123456');
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    http.expectOne('/api/v1/auth/2fa/verify').flush({ data: OWNER_ME });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith('/app');
  });

  it('rejects malformed codes locally', async () => {
    const { fixture, el, http } = setup();
    type(el, '12ab');
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    fixture.detectChanges();
    http.expectNone('/api/v1/auth/2fa/verify');
    expect(el.textContent).toContain('Enter the 6-digit code.');
  });

  it('can switch to a recovery code', async () => {
    const { fixture, el, http } = setup();
    const toggle = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('recovery code'))!;
    toggle.click();
    fixture.detectChanges();
    type(el, 'ABCDE-FGHJK');
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const req = http.expectOne('/api/v1/auth/2fa/verify');
    expect(req.request.body).toEqual({ recoveryCode: 'ABCDE-FGHJK' });
    req.flush({ data: OWNER_ME });
  });
});
