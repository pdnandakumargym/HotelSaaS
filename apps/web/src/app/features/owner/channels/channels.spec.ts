import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Channels } from './channels';

const URL = '/api/v1/organizations/01900000-0000-7000-8000-000000000001/channels';
const payload = (state: string, channels: unknown = null) => ({
  data: {
    provider: { displayName: 'Zodomus', environment: 'sandbox', state },
    availableChannels: channels ? { items: channels, itemCount: 2, fetchedAt: '2026-10-16T10:00:00Z' } : null,
    plan: { code: 'FREE', maxChannels: 2, channelsInUse: 0 },
    properties: [{ id: 'p1', name: 'Sea View Villa', status: 'ACTIVE', connections: [] }],
    mapping: { available: true, channelOptions: [{ channelId: 1, name: 'Booking.com' }] },
  },
});

describe('Channels page', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth(OWNER_ME);
    const fixture = TestBed.createComponent(Channels);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement };
  }

  it('shows provider availability and the channel list, but never a connected property', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(URL).flush(payload('available', { channels: [{ id: 1, name: 'Booking.com' }, { id: 2, channelName: 'Expedia' }] }));
    await fixture.whenStable();
    const text = el.textContent ?? '';
    expect(text).toContain('Available');
    expect(text).toContain('Booking.com');
    expect(text).toContain('Expedia');
    expect(text).toContain('Sea View Villa');
    expect(text).toContain('Not connected');
    expect(text).toContain('0 / 2');
    expect(el.querySelector('a.conn')).toBeNull();
  });

  it('shows a real Booking.com connection when one exists', async () => {
    const { fixture, http, el } = setup();
    const body = payload('available');
    body.data.properties[0]!.connections = [{ id: 'c1', channelId: 1, channelName: 'Booking.com', channelPropertyId: '123', status: 'ACTIVE', environment: 'sandbox', lastError: null, mappedRooms: 2 }] as never[];
    http.expectOne(URL).flush(body);
    await fixture.whenStable();
    expect(el.querySelector('a.conn')?.textContent).toContain('Booking.com · Connected');
  });

  it('explains when the channel manager is not configured and the list is not loaded', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(URL).flush(payload('not_configured'));
    await fixture.whenStable();
    expect(el.textContent).toContain('Not configured');
    expect(el.textContent).toContain('has not been loaded from Zodomus yet');
  });
});
