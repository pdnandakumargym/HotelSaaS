import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Discrepancies } from './discrepancies';

const ORG = '/api/v1/organizations/01900000-0000-7000-8000-000000000001';
const ITEM = {
  id: 'd1', propertyId: 'p1', propertyName: 'Lake View', connectionId: 'c1', reservationId: null, channelReservationId: null, kind: 'OVERBOOKING', severity: 'high', status: 'OPEN',
  message: 'Family Suite is overbooked: 2 booked but 1 in service on 2026-11-02.', occurrences: 2, firstSeenAt: '2026-10-19T08:00:00Z', lastSeenAt: '2026-10-19T09:00:00Z', resolvedAt: null, autoResolved: false, resolutionNote: null,
};

describe('Discrepancy center', () => {
  function setup(permissions = OWNER_ME.memberships![0]!.permissions.concat('channel.manage')) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, permissions }] });
    const fixture = TestBed.createComponent(Discrepancies);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    fixture.componentInstance.onProperty({ id: 'p1', name: 'Lake View' } as never);
    return { fixture, http, el: fixture.nativeElement as HTMLElement };
  }
  const list = (http: HttpTestingController) => http.expectOne((r) => r.url === `${ORG}/discrepancies`);

  it('shows open problems with severity, guidance and counts', async () => {
    const { fixture, http, el } = setup();
    const req = list(http);
    expect(req.request.params.get('status')).toBe('OPEN');
    req.flush({ data: { items: [ITEM], openBySeverity: { high: 1 } } });
    await fixture.whenStable();
    fixture.detectChanges();
    const text = el.textContent ?? '';
    expect(text).toContain('Overbooking');
    expect(text).toContain('2 booked but 1 in service');
    expect(text).toContain('seen 2 times');
    expect(text).toContain('1 high');
    expect(text).toContain('Move or cancel a booking');
    expect(text).toContain('Mark resolved');
  });

  it('resolves with a note', async () => {
    const { fixture, http } = setup();
    list(http).flush({ data: { items: [ITEM], openBySeverity: { high: 1 } } });
    await fixture.whenStable();
    const cmp = fixture.componentInstance as unknown as { start: (d: unknown, w: string) => void; decide: (d: unknown, w: string) => void; note: string };
    cmp.start(ITEM, 'resolve');
    cmp.note = 'Moved guest to room 202';
    cmp.decide(ITEM, 'resolve');
    const req = http.expectOne(`${ORG}/discrepancies/d1/resolve`);
    expect(req.request.body).toEqual({ note: 'Moved guest to room 202' });
  });

  it('offers no actions without channel.manage', async () => {
    const { fixture, http, el } = setup(['org.read', 'property.read', 'booking.read']);
    list(http).flush({ data: { items: [ITEM], openBySeverity: { high: 1 } } });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Mark resolved');
  });
});
