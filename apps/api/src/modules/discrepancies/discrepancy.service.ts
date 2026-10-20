import type { Prisma } from '../../generated/prisma/client.js';
import type { DiscrepancyKind } from '../../generated/prisma/enums.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant, type Tx } from '../../infrastructure/db/tenant.js';
import { AppError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { addDays, fromDbDate, todayIn, toSegments } from '../rates/dates.js';
import { bookedNights } from '../rates/calendar.service.js';

export type Severity = 'high' | 'medium' | 'low';

export interface RaiseInput {
  organizationId: string;
  propertyId: string;
  connectionId?: string | null;
  reservationId?: string | null;
  syncJobId?: string | null;
  kind: DiscrepancyKind;
  severity: Severity;
  message: string;
  /** Non-personal details only (dates, ids, counts, provider codes). */
  details?: Record<string, unknown>;
  dedupeKey: string;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002';

/**
 * Opens a discrepancy, or — when the same problem (dedupe key) is already open — refreshes it and counts
 * the repeat. Runs inside the caller's tenant transaction.
 */
export async function raiseDiscrepancy(tx: Tx, d: RaiseInput): Promise<void> {
  const data = {
    message: d.message.slice(0, 300),
    severity: d.severity,
    details: (d.details ?? {}) as Prisma.InputJsonValue,
    connectionId: d.connectionId ?? null,
    reservationId: d.reservationId ?? null,
    syncJobId: d.syncJobId ?? null,
  };
  const open = await tx.discrepancy.findFirst({ where: { organizationId: d.organizationId, dedupeKey: d.dedupeKey, status: 'OPEN' }, select: { id: true } });
  if (open) {
    await tx.discrepancy.update({ where: { id: open.id }, data: { ...data, occurrences: { increment: 1 }, lastSeenAt: new Date() } });
    return;
  }
  try {
    // A savepoint keeps the surrounding transaction usable if a concurrent poller inserted the same key.
    await tx.$executeRaw`SAVEPOINT raise_discrepancy`;
    await tx.discrepancy.create({ data: { ...data, organizationId: d.organizationId, propertyId: d.propertyId, kind: d.kind, dedupeKey: d.dedupeKey.slice(0, 200) } });
    await tx.$executeRaw`RELEASE SAVEPOINT raise_discrepancy`;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT raise_discrepancy`;
    await tx.discrepancy.updateMany({ where: { organizationId: d.organizationId, dedupeKey: d.dedupeKey, status: 'OPEN' }, data: { ...data, occurrences: { increment: 1 }, lastSeenAt: new Date() } });
  }
}

/** Marks an open discrepancy as resolved because StaySync saw that the problem is gone. */
export async function autoResolve(tx: Tx, organizationId: string, dedupeKey: string, note: string): Promise<number> {
  const r = await tx.discrepancy.updateMany({
    where: { organizationId, dedupeKey, status: 'OPEN' },
    data: { status: 'RESOLVED', resolvedAt: new Date(), autoResolved: true, resolutionNote: note.slice(0, 500) },
  });
  return r.count;
}

/**
 * Compares bookings with rooms in service for the given room types and dates. Opens (or refreshes) one
 * OVERBOOKING discrepancy per room type while any date is overbooked, and resolves it when none is.
 */
export async function checkOverbooking(tx: Tx, organizationId: string, propertyId: string, roomTypeIds: string[], from: string, to: string): Promise<void> {
  if (!roomTypeIds.length || to <= from) return;
  for (const roomTypeId of new Set(roomTypeIds)) {
    const [inService, booked, roomType] = await Promise.all([
      tx.room.count({ where: { propertyId, roomTypeId, status: 'AVAILABLE' } }),
      bookedNights(tx, roomTypeId, from, to),
      tx.roomType.findUnique({ where: { id: roomTypeId }, select: { name: true } }),
    ]);
    const over = [...booked.entries()].filter(([, n]) => n > inService).map(([date, n]) => ({ date, booked: n }));
    const key = `overbooking:${roomTypeId}`;
    if (!over.length) {
      // Only resolve when the whole known future is clear, not just the range checked now.
      const property = await tx.property.findUniqueOrThrow({ where: { id: propertyId }, select: { timezone: true } });
      const today = todayIn(property.timezone);
      const future = await bookedNights(tx, roomTypeId, today, addDays(today, 730));
      if (![...future.values()].some((n) => n > inService)) await autoResolve(tx, organizationId, key, 'No date is overbooked any more.');
      continue;
    }
    const ranges = toSegments(
      over.map((o) => o.date),
      () => true,
      () => 'x',
    ).map((s) => ({ from: s.dateFrom, to: addDays(s.dateTo, -1) }));
    const first = over[0]!;
    await raiseDiscrepancy(tx, {
      organizationId,
      propertyId,
      kind: 'OVERBOOKING',
      severity: 'high',
      message: `${roomType?.name ?? 'A room type'} is overbooked: ${first.booked} booked but ${inService} in service on ${first.date}${over.length > 1 ? ` (and ${over.length - 1} more night${over.length > 2 ? 's' : ''})` : ''}.`,
      details: { roomTypeId, inService, nights: over.slice(0, 60), ranges: ranges.slice(0, 20) },
      dedupeKey: key,
    });
  }
}

export interface DiscrepancyFilter {
  propertyId?: string;
  status?: 'OPEN' | 'RESOLVED' | 'IGNORED';
  limit: number;
}

export class DiscrepancyService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  list(organizationId: string, f: DiscrepancyFilter) {
    return withTenant(this.db, organizationId, async (tx) => {
      const where = { ...(f.propertyId ? { propertyId: f.propertyId } : {}), ...(f.status ? { status: f.status } : {}) };
      const [items, open] = await Promise.all([
        tx.discrepancy.findMany({
          where,
          orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
          take: f.limit,
          include: { property: { select: { name: true } }, reservation: { select: { channelReservationId: true } } },
        }),
        tx.discrepancy.groupBy({ by: ['severity'], where: { ...(f.propertyId ? { propertyId: f.propertyId } : {}), status: 'OPEN' }, _count: { _all: true } }),
      ]);
      return {
        items: items.map(({ property, reservation, ...d }) => ({ ...d, propertyName: property.name, channelReservationId: reservation?.channelReservationId ?? null })),
        openBySeverity: Object.fromEntries(open.map((g) => [g.severity, g._count._all])),
      };
    });
  }

  async decide(organizationId: string, id: string, decision: 'resolve' | 'ignore' | 'reopen', note: string | null, actor: { id: string }, meta: RequestMeta) {
    return withTenant(this.db, organizationId, async (tx) => {
      const d = await tx.discrepancy.findUnique({ where: { id } });
      if (!d) throw new AppError(404, 'NOT_FOUND', 'Discrepancy not found');
      if (decision === 'reopen') {
        if (d.status === 'OPEN') throw new AppError(409, 'ALREADY_OPEN', 'This discrepancy is already open.');
        const dup = await tx.discrepancy.count({ where: { organizationId, dedupeKey: d.dedupeKey, status: 'OPEN' } });
        if (dup) throw new AppError(409, 'ALREADY_OPEN', 'The same problem is already open again.');
      } else if (d.status !== 'OPEN') {
        throw new AppError(409, 'NOT_OPEN', 'This discrepancy is not open.');
      }
      const updated = await tx.discrepancy.update({
        where: { id },
        data:
          decision === 'reopen'
            ? { status: 'OPEN', resolvedAt: null, resolvedById: null, autoResolved: false, resolutionNote: null }
            : { status: decision === 'resolve' ? 'RESOLVED' : 'IGNORED', resolvedAt: new Date(), resolvedById: actor.id, autoResolved: false, resolutionNote: note?.slice(0, 500) ?? null },
      });
      await this.audit.record(
        { action: `discrepancy.${decision === 'resolve' ? 'resolved' : decision === 'ignore' ? 'ignored' : 'reopened'}`, organizationId, actorUserId: actor.id, entityType: 'discrepancy', entityId: id, metadata: { kind: d.kind }, ...meta },
        tx,
      );
      return updated;
    });
  }
}

/** Dates of a reservation room as YYYY-MM-DD (helper shared by services). */
export const dbDate = (d: Date | null): string | null => (d ? fromDbDate(d) : null);
