import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { OWNER_ME, setAuth } from '../../testing/auth-testing';
import { StepUpService } from './step-up.service';

describe('StepUpService', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }));

  it('asks for confirmation on STEP_UP_REQUIRED and retries the action once confirmed', async () => {
    setAuth(OWNER_ME);
    const svc = TestBed.inject(StepUpService);
    const http = TestBed.inject(HttpClient);
    const ctl = TestBed.inject(HttpTestingController);
    let result: unknown;
    svc.run(() => http.post('/api/v1/auth/password/change', {})).subscribe((r) => (result = r));

    ctl.expectOne('/api/v1/auth/password/change').flush({ error: { code: 'STEP_UP_REQUIRED', message: 'Confirm' } }, { status: 403, statusText: 'Forbidden' });
    expect(svc.open()).toBe(true);

    svc.finish(true);
    await Promise.resolve();
    ctl.expectOne('/api/v1/auth/password/change').flush({ data: { status: 'password_changed' } });
    expect(result).toEqual({ data: { status: 'password_changed' } });
    expect(svc.open()).toBe(false);
  });

  it('passes other errors through and does not retry when cancelled', async () => {
    setAuth(OWNER_ME);
    const svc = TestBed.inject(StepUpService);
    const http = TestBed.inject(HttpClient);
    const ctl = TestBed.inject(HttpTestingController);
    let failed = false;
    svc.run(() => http.post('/api/v1/x', {})).subscribe({ error: () => (failed = true) });
    ctl.expectOne('/api/v1/x').flush({ error: { code: 'STEP_UP_REQUIRED' } }, { status: 403, statusText: 'Forbidden' });
    svc.finish(false);
    await Promise.resolve();
    ctl.expectNone('/api/v1/x');
    expect(failed).toBe(true);
  });
});
