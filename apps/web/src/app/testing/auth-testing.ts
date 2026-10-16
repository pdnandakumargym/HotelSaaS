import { TestBed } from '@angular/core/testing';
import { Me } from '../core/auth/auth.models';
import { AuthService } from '../core/auth/auth.service';

export const OWNER_ME: Me = {
  state: 'authenticated',
  user: { id: 'u1', email: 'owner@example.test', displayName: 'Asha Rao', platformRole: null, twoFactorEnabled: false, twoFactorRequired: false },
  memberships: [
    {
      organizationId: '01900000-0000-7000-8000-000000000001',
      organizationName: 'Asha Homestays',
      role: 'ORG_OWNER',
      permissions: ['org.read', 'member.read', 'property.read', 'audit.read', 'org.security.manage'],
    },
  ],
  platformPermissions: [],
  session: { id: 's1', expiresAt: '2030-01-01T00:00:00.000Z', recentAuth: true },
};

export const ADMIN_ME: Me = {
  state: 'authenticated',
  user: { id: 'a1', email: 'admin@example.test', displayName: 'Pat Admin', platformRole: 'PLATFORM_SUPER_ADMIN', twoFactorEnabled: true, twoFactorRequired: true },
  memberships: [],
  platformPermissions: ['admin.access', 'admin.org.read', 'admin.org.manage', 'admin.billing.manage', 'admin.user.read', 'admin.user.manage', 'admin.audit.read', 'admin.support.request', 'admin.integration.read', 'admin.integration.manage'],
  session: { id: 's2', expiresAt: '2030-01-01T00:00:00.000Z', recentAuth: true },
};

/** Puts AuthService into a known state without an HTTP round trip. */
export function setAuth(me: Me): AuthService {
  const auth = TestBed.inject(AuthService);
  auth.me.set(me);
  auth.loaded.set(true);
  return auth;
}
