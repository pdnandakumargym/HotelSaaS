import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Mapping } from './mapping';

const ORG = '/api/v1/organizations/01900000-0000-7000-8000-000000000001';
const P = `${ORG}/properties/p1`;
const OPTIONS = { data: { ready: true, environment: 'sandbox', channels: [{ channelId: 1, name: 'Booking.com', priceModels: [{ id: 2, name: 'Derived prices', recommended: true }, { id: 1, name: 'Maximum / single' }] }] } };
const ACTIVATED = {
  id: 'c1', propertyId: 'p1', environment: 'sandbox', channelId: 1, channelName: 'Booking.com', channelPropertyId: '555', priceModelId: 2, currency: 'INR',
  status: 'ACTIVATED', lastError: null, lastCheckAt: null, lastCheckMessage: null, activatedAt: '2026-10-17T00:00:00Z', roomsActivatedAt: null, channelRoomsFetchedAt: '2026-10-17T00:00:00Z',
  channelRooms: [{ id: '90001', name: 'Double Room', rates: [{ id: '99001', name: 'Standard Rate', active: true, maxPersons: 2 }] }],
  roomMappings: [],
};

describe('Booking.com mapping page', () => {
  function setup(permissions = OWNER_ME.memberships![0]!.permissions.concat('channel.manage')) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, permissions }] });
    const fixture = TestBed.createComponent(Mapping);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    fixture.componentInstance.onProperty({ id: 'p1', name: 'Lake View' } as never);
    return { fixture, http, el: fixture.nativeElement as HTMLElement };
  }
  function flushBase(http: HttpTestingController, connections: unknown[]) {
    http.expectOne(`${ORG}/channel-options`).flush(OPTIONS);
    http.expectOne(`${P}/channel-connections`).flush({ data: connections });
    http.expectOne(`${P}/room-types`).flush({ data: [{ id: 'rt1', name: 'Deluxe', status: 'ACTIVE', roomCount: 3 }] });
    http.expectOne(`${P}/rate-plans`).flush({ data: [{ id: 'rp1', name: 'Standard', code: 'STD', status: 'ACTIVE' }] });
  }

  it('offers to connect with the recommended price model and explains test mode', async () => {
    const { fixture, http, el } = setup();
    flushBase(http, []);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Connect to Booking.com');
    expect(el.textContent).toContain('use any number as the Booking.com property ID');
    expect((fixture.componentInstance as unknown as { priceModelId: number }).priceModelId).toBe(2);
    expect(el.querySelectorAll('input[type=radio]')).toHaveLength(2);
  });

  it('sends the mapping chosen by the owner', async () => {
    const { fixture, http, el } = setup();
    flushBase(http, [ACTIVATED]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Double Room');
    const cmp = fixture.componentInstance as unknown as { setRoom(a: string, b: string): void; setRate(a: string, b: string, c: string): void; saveMapping(c: unknown): void };
    cmp.setRoom('90001', 'rt1');
    cmp.setRate('90001', '99001', 'rp1');
    cmp.saveMapping(ACTIVATED);
    const req = http.expectOne(`${P}/channel-connections/c1/mapping`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ rooms: [{ channelRoomId: '90001', roomTypeId: 'rt1', rates: [{ channelRateId: '99001', ratePlanId: 'rp1' }] }] });
    req.flush({ data: { connection: { ...ACTIVATED, status: 'ACTIVE', roomMappings: [] }, steps: [{ step: 'rooms-activation', result: { ok: true, outcome: 'SUCCESS' } }], syncJobsQueued: 3 } });
    http.expectOne(`${P}/channel-connections/c1/jobs`).flush({ data: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('3 updates');
  });

  it('hides management actions without channel.manage', async () => {
    const { fixture, http, el } = setup(['org.read', 'property.read']);
    flushBase(http, []);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Ask an owner or manager');
    expect(el.querySelector('form')).toBeNull();
  });
});
