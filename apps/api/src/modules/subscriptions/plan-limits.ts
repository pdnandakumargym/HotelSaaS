import type { Tx } from '../../infrastructure/db/tenant.js';
import { AppError } from '../../shared/errors.js';

export interface PlanInfo {
  code: string;
  name: string;
  maxProperties: number;
  maxUsers: number;
  maxChannels: number;
  priceMonthlyMinor: number;
  currency: string;
}

export interface SubscriptionInfo {
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  plan: PlanInfo;
}

const planSelect = { code: true, name: true, maxProperties: true, maxUsers: true, maxChannels: true, priceMonthlyMinor: true, currency: true } as const;

/** Creates the default subscription (Free plan with its trial) for a new organization. */
export async function createDefaultSubscription(tx: Tx, organizationId: string, now = new Date()): Promise<void> {
  const free = await tx.plan.findUniqueOrThrow({ where: { code: 'FREE' } });
  await tx.subscription.create({
    data: {
      organizationId,
      planId: free.id,
      status: free.trialDays > 0 ? 'TRIALING' : 'ACTIVE',
      trialEndsAt: free.trialDays > 0 ? new Date(now.getTime() + free.trialDays * 86_400_000) : null,
    },
  });
}

/** Subscription for an organization; falls back to Free limits if none exists (fail safe = most restrictive). */
export async function getSubscription(tx: Tx, organizationId: string): Promise<SubscriptionInfo> {
  const sub = await tx.subscription.findUnique({ where: { organizationId }, include: { plan: { select: planSelect } } });
  if (sub) return { status: sub.status, trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, plan: sub.plan };
  const free = await tx.plan.findUniqueOrThrow({ where: { code: 'FREE' }, select: planSelect });
  return { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null, plan: free };
}

export async function usage(tx: Tx, organizationId: string, now = new Date()) {
  const [properties, members, pendingInvitations] = await Promise.all([
    tx.property.count({ where: { organizationId } }),
    tx.organizationMembership.count({ where: { organizationId } }),
    tx.invitation.count({ where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
  ]);
  return { properties, members, pendingInvitations, users: members + pendingInvitations, channels: 0 };
}

/** Plan limits are enforced by the API, not the UI. */
export async function assertCanAddProperty(tx: Tx, organizationId: string): Promise<void> {
  const [sub, u] = await Promise.all([getSubscription(tx, organizationId), usage(tx, organizationId)]);
  if (sub.status === 'CANCELED') throw new AppError(402, 'SUBSCRIPTION_INACTIVE', 'Your subscription is canceled. Choose a plan to continue.');
  if (u.properties >= sub.plan.maxProperties) {
    throw new AppError(402, 'PLAN_LIMIT_REACHED', `Your ${sub.plan.name} plan allows ${sub.plan.maxProperties} propert${sub.plan.maxProperties === 1 ? 'y' : 'ies'}. Upgrade to add more.`, {
      limit: 'properties',
      max: sub.plan.maxProperties,
    });
  }
}

export async function assertCanAddUser(tx: Tx, organizationId: string): Promise<void> {
  const [sub, u] = await Promise.all([getSubscription(tx, organizationId), usage(tx, organizationId)]);
  if (sub.status === 'CANCELED') throw new AppError(402, 'SUBSCRIPTION_INACTIVE', 'Your subscription is canceled. Choose a plan to continue.');
  if (u.users >= sub.plan.maxUsers) {
    throw new AppError(402, 'PLAN_LIMIT_REACHED', `Your ${sub.plan.name} plan allows ${sub.plan.maxUsers} users (including pending invitations). Upgrade to add more.`, {
      limit: 'users',
      max: sub.plan.maxUsers,
    });
  }
}
