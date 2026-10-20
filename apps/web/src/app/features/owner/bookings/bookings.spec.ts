import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Bookings } from './bookings';

const ORG = '/api/v1/organizations/01900000-0000-7000-8000-000000000001';
const ACTIVE = { id: 'c1', propertyId: 'p1', environment: 'sandbox', channelId: 1, channelName: 'Booking.com', status: 'ACTIVE', roomMappings: [] };
const ROW = {
  id: 'r1', propertyId: 'p1', propertyName: 'Lake View', connectionId: 'c1', channelName: 'Booking.com', channelReservationId: '4711', environment: 'sandbox', isTest: true,
  status: 'CONFIRMED', checkIn: '2026-11-02', checkOut: '2026-11-04', nights: 2, currency: 'INR', total: 9000, guestCount: 2, roomCount: 1, roomTypes: ['Deluxe'],
  guestName: 'Asha Rao', needsReview: false, reviewReason: null, source: 'TEST', receivedAt: '2026-10-19T08:00:00Z', updatedAt: '2026-10-19T08:00:00Z', cancelledAt: null, version: 1,
};

describe('Bookings page', () => {
  function setup(permissions = OWNER_ME.memberships![0]!.permissions.concat('channel.manage')) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, permissions }] });
    const fixture = TestBed.createComponent(Bookings);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    fixture.componentInstance.onProperty({ id: 'p1', name: 'Lake View' } as never);
    return { fixture, http, el: fixture.nativeElement as HTMLElement };
  }
  const list = (http: HttpTestingController) => http.expectOne((r) => r.url === `${ORG}/reservations`);

  it('lists channel bookings, marks test mode and offers fetch and test-booking actions', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(`${ORG}/properties/p1/channel-connections`).flush({ data: [ACTIVE] });
    const req = list(http);
    expect(req.request.params.get('view')).toBe('upcoming');
    expect(req.request.params.get('propertyId')).toBe('p1');
    req.flush({ data: { total: 1, guestDetailsVisible: true, items: [ROW] } });
    await fixture.whenStable();
    fixture.detectChanges();
    const text = el.textContent ?? '';
    expect(text).toContain('4711');
    expect(text).toContain('Asha Rao');
    expect(text).toContain('Confirmed');
    expect(text).toContain('test bookings created by Zodomus');
    expect(text).toContain('Fetch new bookings now');
    expect(text).toContain('Create a test booking');
  });

  it('hides guest names when the role has no guest-data permission and offers no actions to read-only users', async () => {
    const { fixture, http, el } = setup(['org.read', 'property.read', 'booking.read']);
    http.expectOne(`${ORG}/properties/p1/channel-connections`).flush({ data: [ACTIVE] });
    list(http).flush({ data: { total: 1, guestDetailsVisible: false, items: [{ ...ROW, guestName: null }] } });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Guest names are hidden for your role');
    expect(el.textContent).toContain('Hidden');
    expect(el.textContent).not.toContain('Fetch new bookings now');
  });

  it('sends a test booking request with digits only', async () => {
    const { fixture, http } = setup();
    http.expectOne(`${ORG}/properties/p1/channel-connections`).flush({ data: [ACTIVE] });
    list(http).flush({ data: { total: 0, guestDetailsVisible: true, items: [] } });
    await fixture.whenStable();
    const cmp = fixture.componentInstance as unknown as { testId: string; testStatus: string; createTest: (c: unknown) => void; error: () => string | null };
    cmp.testId = '12a';
    cmp.createTest(ACTIVE);
    expect(cmp.error()).toContain('digits only');
    cmp.testId = '777';
    cmp.testStatus = 'cancelled';
    cmp.createTest(ACTIVE);
    const req = http.expectOne(`${ORG}/properties/p1/channel-connections/c1/reservations/test`);
    expect(req.request.body).toEqual({ status: 'cancelled', channelReservationId: '777' });
  });

  it('explains when the property is not connected', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(`${ORG}/properties/p1/channel-connections`).flush({ data: [] });
    list(http).flush({ data: { total: 0, guestDetailsVisible: true, items: [] } });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('not connected to a channel');
    expect(el.textContent).toContain('No bookings match');
  });
});
