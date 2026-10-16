import type { OrganizationRole, PlatformRole } from '../../generated/prisma/enums.js';

/** Organization-scoped permissions (checked against the caller's membership in that organization). */
export const ORG_PERMISSIONS = [
  'org.read',
  'org.update',
  'org.security.manage',
  'member.read',
  'member.manage',
  'property.read',
  'property.write',
  'inventory.write',
  'rate.write',
  'booking.read',
  'booking.guest_pii.read',
  'channel.manage',
  'billing.manage',
  'audit.read',
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

/** Platform-scoped permissions. Note: none of these grant access to tenant data or guest PII. */
export const PLATFORM_PERMISSIONS = [
  'admin.access',
  'admin.org.read',
  'admin.org.manage',
  'admin.billing.manage',
  'admin.user.read',
  'admin.user.manage',
  'admin.audit.read',
  'admin.support.request',
  'admin.integration.read',
  'admin.integration.manage',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const ORG_ROLE_PERMISSIONS: Record<OrganizationRole, readonly OrgPermission[]> = {
  ORG_OWNER: ORG_PERMISSIONS,
  PROPERTY_MANAGER: [
    'org.read',
    'member.read',
    'property.read',
    'property.write',
    'inventory.write',
    'rate.write',
    'booking.read',
    'booking.guest_pii.read',
    'channel.manage',
  ],
  PROPERTY_STAFF: ['org.read', 'property.read', 'inventory.write', 'booking.read', 'booking.guest_pii.read'],
  READ_ONLY: ['org.read', 'property.read', 'booking.read'],
};

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  PLATFORM_SUPER_ADMIN: PLATFORM_PERMISSIONS,
  PLATFORM_SUPPORT: ['admin.access', 'admin.org.read', 'admin.user.read', 'admin.support.request', 'admin.integration.read'],
};

export function orgRoleHas(role: OrganizationRole, permission: OrgPermission): boolean {
  return ORG_ROLE_PERMISSIONS[role].includes(permission);
}

export function platformRoleHas(role: PlatformRole | null, permission: PlatformPermission): boolean {
  return role !== null && PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}
