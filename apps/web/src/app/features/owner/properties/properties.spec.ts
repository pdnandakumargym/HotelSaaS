import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Properties } from './properties';

const BASE = '/api/v1/organizations/01900000-0000-7000-8000-000000000001';
const SUB = (used: number, max: number) => ({ data: { status: 'TRIALING', plan: { code: 'FREE', name: 'Free', maxProperties: max }, usage: { properties: used } } });

describe('Properties page', () => {
  function setup(permissions = OWNER_ME.memberships![0]!.permissions.concat('property.write')) {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, permissions }] });
    const fixture = TestBed.createComponent(Properties);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController), el: fixture.nativeElement as HTMLElement };
  }

  it('shows properties and plan usage', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(`${BASE}/properties?pageSize=100`).flush({
      data: [{ id: 'p1', name: 'Sea View Villa', propertyType: 'VILLA', status: 'ACTIVE', city: 'Chennai', countryCode: 'IN', timezone: 'Asia/Kolkata', roomTypeCount: 3, roomCount: 10 }],
    });
    http.expectOne(`${BASE}/subscription`).flush(SUB(1, 3));
    await fixture.whenStable();
    expect(el.textContent).toContain('Sea View Villa');
    expect(el.textContent).toContain('Villa · Chennai, IN');
    expect(el.textContent).toContain('1 of 3 properties used');
    expect(el.textContent).toContain('Add property');
  });

  it('replaces the add button when the plan limit is reached', async () => {
    const { fixture, http, el } = setup();
    http.expectOne(`${BASE}/properties?pageSize=100`).flush({ data: [] });
    http.expectOne(`${BASE}/subscription`).flush(SUB(1, 1));
    await fixture.whenStable();
    expect(el.textContent).toContain('Plan limit reached');
  });

  it('hides write actions without property.write', async () => {
    const { fixture, http, el } = setup(['org.read', 'property.read']);
    http.expectOne(`${BASE}/properties?pageSize=100`).flush({ data: [] });
    http.expectOne(`${BASE}/subscription`).flush(SUB(0, 3));
    await fixture.whenStable();
    expect(el.textContent).toContain('No properties yet');
    expect(el.querySelector('a.ss-btn')).toBeNull();
  });
});
