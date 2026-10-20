import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Promotions } from './promotions';

const P = '/api/v1/organizations/01900000-0000-7000-8000-000000000001/properties/p1';
const CONN = { id: 'c1', propertyId: 'p1', environment: 'sandbox', channelName: 'Booking.com', status: 'ACTIVE', roomMappings: [] };
const PROMO = { id: '5551', name: 'Early summer', type: 'basic', active: true, nonRefundable: true, minStayThrough: 2, discount: '15', stayFrom: '2027-04-01', stayTo: '2027-06-30', bookFrom: null, bookTo: null, roomIds: [], stats: { revenue: '1200.00', currency: 'INR', roomNights: 4, bookings: 2, cancellations: 0 } };

describe('Promotions page', () => {
  it('lists active promotions and deactivates after confirmation', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, permissions: OWNER_ME.memberships![0]!.permissions.concat('channel.manage') }] });
    const fixture = TestBed.createComponent(Promotions);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    fixture.componentInstance.onProperty({ id: 'p1', name: 'Lake View' } as never);
    http.expectOne(`${P}/channel-connections`).flush({ data: [CONN] });
    http.expectOne((r) => r.url === `${P}/channel-connections/c1/promotions` && r.params.get('active') === '1').flush({ data: [PROMO] });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Early summer');
    expect(el.textContent).toContain('15% off');
    expect(el.textContent).toContain('2 bookings · 4 room nights');
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Deactivate'))!;
    btn.click();
    fixture.detectChanges();
    expect(btn.textContent).toContain('Click again');
    btn.click();
    http.expectOne(`${P}/channel-connections/c1/promotions/5551/deactivate`).flush({ data: { promotionId: '5551', active: false } });
  });
});
