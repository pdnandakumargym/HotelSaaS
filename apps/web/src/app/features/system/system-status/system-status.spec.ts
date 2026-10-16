import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SystemStatusCard } from './system-status';

const LIVE = { data: { status: 'ok', service: 'StaySync API', version: '0.1.0', environment: 'development', uptimeSeconds: 5, timestamp: '' } };

describe('SystemStatusCard', () => {
  let http: HttpTestingController;

  async function render() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SystemStatusCard);
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => http.verify());

  it('shows healthy API and database', async () => {
    const fixture = await render();
    http.expectOne('/api/v1/health').flush(LIVE);
    http.expectOne('/api/v1/health/ready').flush({ data: { status: 'ready', checks: { database: { status: 'up', latencyMs: 3 } }, timestamp: '' } });
    await fixture.whenStable();
    const t = fixture.nativeElement.textContent as string;
    expect(t).toContain('Healthy · 3 ms');
    expect(t).toContain('StaySync API v0.1.0');
    expect(t).toContain('Not configured');
  });

  it('shows database down when readiness returns 503', async () => {
    const fixture = await render();
    http.expectOne('/api/v1/health').flush(LIVE);
    http
      .expectOne('/api/v1/health/ready')
      .flush({ data: { status: 'not_ready', checks: { database: { status: 'down', latencyMs: 2000 } }, timestamp: '' } }, { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Down');
  });

  it('shows an unreachable API without crashing', async () => {
    const fixture = await render();
    http.expectOne('/api/v1/health').error(new ProgressEvent('error'), { status: 0 });
    await fixture.whenStable();
    const t = fixture.nativeElement.textContent as string;
    expect(t).toContain('Unreachable');
    expect(t).toContain('Cannot reach the StaySync API');
  });

  it('sends API requests with credentials only to /api', async () => {
    const fixture = await render();
    const req = http.expectOne('/api/v1/health');
    expect(req.request.url.startsWith('/api/')).toBe(true);
    req.flush(LIVE);
    http.expectOne('/api/v1/health/ready').flush({ data: { status: 'ready', checks: { database: { status: 'up', latencyMs: 1 } }, timestamp: '' } });
    await fixture.whenStable();
  });
});
