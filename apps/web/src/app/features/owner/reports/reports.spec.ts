import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Reports } from './reports';

const ORG = '/api/v1/organizations/01900000-0000-7000-8000-000000000001';
const DATA = {
  property: { id: 'p1', name: 'Lake View', currency: 'INR', timezone: 'Asia/Kolkata' },
  from: '2026-11-01', to: '2026-11-03', nights: 3, includeTest: true, testBookingsInRange: 1, otherCurrencyBookings: 0,
  totals: { roomsInService: 3, roomNightsAvailable: 9, roomNightsSold: 4, occupancyPct: 44.4, revenue: 19000, adr: 4750, revpar: 2111.11, bookingsStaying: 4, cancellationsStaying: 1, bookingsReceived: 2, cancellationsReceived: 0 },
  daily: [{ date: '2026-11-01', roomNightsSold: 2, occupancyPct: 66.7, revenue: 8500 }, { date: '2026-11-02', roomNightsSold: 2, occupancyPct: 66.7, revenue: 10500 }, { date: '2026-11-03', roomNightsSold: 0, occupancyPct: 0, revenue: 0 }],
  byRoomType: [{ roomTypeId: 'rt1', name: 'Deluxe', roomsInService: 2, roomNightsSold: 3, occupancyPct: 50, revenue: 13000, adr: 4333.33 }],
  byChannel: [{ channel: 'Booking.com', bookings: 4, cancellations: 1, roomNights: 4, revenue: 19000, sharePct: 100 }],
};

describe('Reports page', () => {
  it('loads the next 30 days for the property and shows KPIs, chart and tables', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth(OWNER_ME);
    const fixture = TestBed.createComponent(Reports);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    fixture.componentInstance.onProperty({ id: 'p1', name: 'Lake View' } as never);
    const req = http.expectOne((r) => r.url === `${ORG}/reports/summary`);
    expect(req.request.params.get('propertyId')).toBe('p1');
    expect(req.request.params.get('includeTest')).toBe('true');
    req.flush({ data: DATA });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('44.4%');
    expect(el.textContent).toContain('4 of 9 room nights');
    expect(el.textContent).toContain('Includes 1 test booking');
    expect(el.querySelectorAll('.bar')).toHaveLength(3);
    expect(el.textContent).toContain('Deluxe');
    expect(el.querySelector('a[download]')?.getAttribute('href')).toContain('/reports/summary.csv?propertyId=p1');
  });
});
