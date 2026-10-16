import type { RequestHandler } from 'express';
import type { OrganizationRole } from '../generated/prisma/enums.js';
import { orgRoleHas, ORG_ROLE_PERMISSIONS, type OrgPermission } from '../modules/rbac/permissions.js';
import { AppError } from '../shared/errors.js';

export interface OrgContext {
  organizationId: string;
  role: OrganizationRole;
  permissions: readonly OrgPermission[];
}

declare module 'express-serve-static-core' {
  interface Request {
    org?: OrgContext;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authorizes access to the organization in :orgId using the caller's membership.
 * Non-members get 404 (not 403) so organization ids cannot be probed.
 * Platform roles are NOT members and therefore get no tenant data through these routes.
 */
export function requireOrgPermission(permission: OrgPermission): RequestHandler {
  return (req, _res, next) => {
    const orgId = req.params['orgId'];
    const user = req.auth?.user;
    if (!user) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    if (typeof orgId !== 'string' || !UUID.test(orgId)) return next(new AppError(404, 'NOT_FOUND', 'Organization not found'));
    const membership = user.memberships.find((m) => m.organizationId === orgId);
    if (!membership) return next(new AppError(404, 'NOT_FOUND', 'Organization not found'));
    if (membership.organizationStatus !== 'ACTIVE') {
      return next(new AppError(403, 'ORG_SUSPENDED', 'This organization is suspended. Contact support.'));
    }
    if (!orgRoleHas(membership.role, permission)) {
      return next(new AppError(403, 'FORBIDDEN', 'Your role does not allow this action.'));
    }
    req.org = { organizationId: orgId, role: membership.role, permissions: ORG_ROLE_PERMISSIONS[membership.role] };
    next();
  };
}
