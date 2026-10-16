export type AuthState = 'anonymous' | 'authenticated' | 'mfa_pending' | 'mfa_enrollment_required';
export type OrgRole = 'ORG_OWNER' | 'PROPERTY_MANAGER' | 'PROPERTY_STAFF' | 'READ_ONLY';
export type PlatformRole = 'PLATFORM_SUPER_ADMIN' | 'PLATFORM_SUPPORT';

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  organizationStatus?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  permissions: string[];
}

export interface Me {
  state: AuthState;
  user?: {
    id: string;
    email: string;
    displayName: string;
    platformRole: PlatformRole | null;
    twoFactorEnabled: boolean;
    twoFactorRequired: boolean;
  };
  memberships?: Membership[];
  platformPermissions?: string[];
  session?: { id: string; expiresAt: string; recentAuth: boolean };
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface TotpSetup {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export const ROLE_LABELS: Record<OrgRole, string> = {
  ORG_OWNER: 'Owner',
  PROPERTY_MANAGER: 'Property manager',
  PROPERTY_STAFF: 'Property staff',
  READ_ONLY: 'Read-only viewer',
};
