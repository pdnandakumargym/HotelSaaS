import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OWNER_ME, setAuth } from '../../../testing/auth-testing';
import { Team } from './team';

const BASE = '/api/v1/organizations/01900000-0000-7000-8000-000000000001';

describe('Team page', () => {
  it('invites a member and reloads the lists', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, permissions: ['org.read', 'member.read', 'member.manage'] }] });
    const fixture = TestBed.createComponent(Team);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${BASE}/members`).flush({ data: [{ membershipId: 'm1', role: 'ORG_OWNER', displayName: 'Asha', email: 'a@example.test', twoFactorEnabled: true, lastLoginAt: null, joinedAt: '', isMe: true }] });
    http.expectOne(`${BASE}/invitations`).flush({ data: [] });
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Asha');

    const email = el.querySelector<HTMLInputElement>('input[type=email]')!;
    email.value = 'new@example.test';
    email.dispatchEvent(new Event('input'));
    el.querySelector<HTMLFormElement>('form.invite button[type=submit]')!.click();
    const req = http.expectOne(`${BASE}/invitations`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'new@example.test', role: 'PROPERTY_STAFF' });
    req.flush({ data: { id: 'i1' } });
    http.expectOne(`${BASE}/members`).flush({ data: [] });
    http.expectOne(`${BASE}/invitations`).flush({ data: [{ id: 'i1', email: 'new@example.test', role: 'PROPERTY_STAFF', expiresAt: '2030-01-01', createdAt: '', expired: false }] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.textContent).toContain('Invitation sent to new@example.test');
    expect(el.textContent).toContain('Pending invitations');
  });

  it('shows no management tools to non-owners', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()] });
    setAuth({ ...OWNER_ME, memberships: [{ ...OWNER_ME.memberships![0]!, role: 'PROPERTY_MANAGER', permissions: ['org.read', 'member.read'] }] });
    const fixture = TestBed.createComponent(Team);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(`${BASE}/members`).flush({ data: [] });
    http.expectNone(`${BASE}/invitations`);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Invite someone');
  });
});
