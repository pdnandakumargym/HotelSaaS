import { describe, expect, it } from 'vitest';
import { ORG_PERMISSIONS, ORG_ROLE_PERMISSIONS, orgRoleHas, platformRoleHas, PLATFORM_ROLE_PERMISSIONS } from '../../src/modules/rbac/permissions.js';

describe('RBAC permission matrix', () => {
  it('gives organization owners every organization permission', () => {
    expect([...ORG_ROLE_PERMISSIONS.ORG_OWNER].sort()).toEqual([...ORG_PERMISSIONS].sort());
  });

  it('keeps roles strictly nested: viewer ⊂ staff ⊂ manager ⊂ owner', () => {
    const subset = (a: readonly string[], b: readonly string[]) => a.every((p) => b.includes(p));
    expect(subset(ORG_ROLE_PERMISSIONS.READ_ONLY, ORG_ROLE_PERMISSIONS.PROPERTY_STAFF)).toBe(true);
    expect(subset(ORG_ROLE_PERMISSIONS.PROPERTY_STAFF, ORG_ROLE_PERMISSIONS.PROPERTY_MANAGER)).toBe(true);
    expect(subset(ORG_ROLE_PERMISSIONS.PROPERTY_MANAGER, ORG_ROLE_PERMISSIONS.ORG_OWNER)).toBe(true);
  });

  it.each([
    ['READ_ONLY', 'property.write', false],
    ['READ_ONLY', 'booking.guest_pii.read', false],
    ['PROPERTY_STAFF', 'rate.write', false],
    ['PROPERTY_STAFF', 'inventory.write', true],
    ['PROPERTY_MANAGER', 'member.manage', false],
    ['PROPERTY_MANAGER', 'billing.manage', false],
    ['PROPERTY_MANAGER', 'channel.manage', true],
  ] as const)('%s has %s = %s', (role, perm, expected) => {
    expect(orgRoleHas(role, perm)).toBe(expected);
  });

  it('gives platform roles no tenant (organization) permissions at all', () => {
    for (const perms of Object.values(PLATFORM_ROLE_PERMISSIONS)) {
      expect(perms.every((p) => p.startsWith('admin.'))).toBe(true);
    }
  });

  it('limits platform support to read access', () => {
    expect(platformRoleHas('PLATFORM_SUPPORT', 'admin.user.manage')).toBe(false);
    expect(platformRoleHas('PLATFORM_SUPPORT', 'admin.audit.read')).toBe(false);
    expect(platformRoleHas('PLATFORM_SUPER_ADMIN', 'admin.user.manage')).toBe(true);
    expect(platformRoleHas(null, 'admin.access')).toBe(false);
  });
});
