import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { apiInterceptor } from './api.interceptor';

describe('apiInterceptor', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiInterceptor])), provideHttpClientTesting()],
    });
  });

  it('sends credentials to the same-origin API', () => {
    TestBed.inject(HttpClient).get('/api/v1/health').subscribe();
    const req = TestBed.inject(HttpTestingController).expectOne('/api/v1/health');
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
  });

  it('never attaches credentials to other URLs', () => {
    TestBed.inject(HttpClient).get('https://third-party.example/x').subscribe();
    const req = TestBed.inject(HttpTestingController).expectOne('https://third-party.example/x');
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
  });

  it('returns to sign-in when a protected call reports the session ended', () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    TestBed.inject(HttpClient).get('/api/v1/organizations').subscribe({ error: () => undefined });
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/organizations')
      .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'Unauthorized' });
    expect(navigate).toHaveBeenCalledWith(['/login'], expect.anything());
  });
});
