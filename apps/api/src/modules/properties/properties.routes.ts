import { Router, type Request } from 'express';
import { enqueueAvailabilityResync } from '../channels/sync.service.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withTenant, type Tx } from '../../infrastructure/db/tenant.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError, NotFoundError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import type { AuditService } from '../audit/audit.service.js';
import { requestMeta } from '../auth/auth.routes.js';
import { orgRoleHas } from '../rbac/permissions.js';
import { assertCanAddProperty } from '../subscriptions/plan-limits.js';
import { AMENITIES } from './amenities.js';
import {
  BulkCreateRoomsBody,
  CreatePropertyBody,
  CreateRoomBody,
  CreateRoomTypeBody,
  ListQuery,
  UpdatePropertyBody,
  UpdateRoomBody,
  UpdateRoomTypeBody,
} from './properties.schemas.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for (const [method, path, summary] of [
  ['get', '/amenities', 'Amenity catalog'],
  ['get', '/organizations/{orgId}/properties', 'List properties (property.read)'],
  ['post', '/organizations/{orgId}/properties', 'Create a property (property.write, plan limit)'],
  ['get', '/organizations/{orgId}/properties/{propertyId}', 'Property details with room types and room counts'],
  ['patch', '/organizations/{orgId}/properties/{propertyId}', 'Update a property'],
  ['delete', '/organizations/{orgId}/properties/{propertyId}', 'Delete a property without room types'],
  ['get', '/organizations/{orgId}/properties/{propertyId}/room-types', 'List room types'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/room-types', 'Create a room type'],
  ['patch', '/organizations/{orgId}/properties/{propertyId}/room-types/{roomTypeId}', 'Update a room type'],
  ['delete', '/organizations/{orgId}/properties/{propertyId}/room-types/{roomTypeId}', 'Delete a room type without rooms'],
  ['get', '/organizations/{orgId}/properties/{propertyId}/rooms', 'List rooms/units'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/rooms', 'Create a room/unit'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/rooms/bulk', 'Create several rooms of one type'],
  ['patch', '/organizations/{orgId}/properties/{propertyId}/rooms/{roomId}', 'Update a room (staff may change status only)'],
  ['delete', '/organizations/{orgId}/properties/{propertyId}/rooms/{roomId}', 'Delete a room'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Properties'], summary, responses: { 200: { description: 'OK' }, 404: { description: 'Not found or not a member' } } });
}

type Dec = { toNumber(): number } | null;
const num = (d: Dec) => (d === null ? null : d.toNumber());

function serializeProperty<T extends { latitude: Dec; longitude: Dec }>(p: T) {
  return { ...p, latitude: num(p.latitude), longitude: num(p.longitude) };
}
function serializeRoomType<T extends { sizeSqm: Dec }>(r: T) {
  return { ...r, sizeSqm: num(r.sizeSqm) };
}

function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string' || !UUID.test(v)) throw new NotFoundError();
  return v;
}

async function loadProperty(tx: Tx, propertyId: string) {
  // RLS restricts this lookup to the current tenant; another tenant's id is simply "not found".
  const p = await tx.property.findUnique({ where: { id: propertyId } });
  if (!p) throw new NotFoundError('Property not found');
  return p;
}

export function amenitiesRouter(): Router {
  const r = Router();
  r.get('/', requireAuth(), (_req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    sendData(res, AMENITIES);
  });
  return r;
}

/**
 * Properties, room types and rooms. Mounted at /organizations/:orgId/properties.
 * Every handler runs in withTenant(); PostgreSQL RLS confines all queries to the organization.
 */
export function propertiesRouter(deps: { db: Database; audit: AuditService }): Router {
  const { db, audit } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());

  const tenant = <T>(req: Request, fn: (tx: Tx) => Promise<T>) => withTenant(db, req.org!.organizationId, fn);
  const record = (req: Request, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>, tx: Tx) =>
    audit.record({ action, organizationId: req.org!.organizationId, actorUserId: req.auth!.user.id, entityType, entityId, metadata, ...requestMeta(req) }, tx);

  // --- properties ---------------------------------------------------------------

  r.get('/', requireOrgPermission('property.read'), async (req, res) => {
    const { page, pageSize, status, q } = parseQuery(ListQuery, req);
    const where = {
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { city: { contains: q, mode: 'insensitive' as const } }] } : {}),
    };
    const [items, total] = await tenant(req, (tx) =>
      Promise.all([
        // No organizationId filter on purpose: RLS scopes the query (covered by tests).
        tx.property.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { _count: { select: { roomTypes: true, rooms: true } } },
        }),
        tx.property.count({ where }),
      ]),
    );
    sendData(
      res,
      items.map(({ _count, ...p }) => ({ ...serializeProperty(p), roomTypeCount: _count.roomTypes, roomCount: _count.rooms })),
      200,
      { page, pageSize, total },
    );
  });

  r.post('/', requireOrgPermission('property.write'), async (req, res) => {
    const body = parseBody(CreatePropertyBody, req);
    const orgId = req.org!.organizationId;
    const created = await tenant(req, async (tx) => {
      await assertCanAddProperty(tx, orgId);
      const p = await tx.property.create({ data: { ...body, organizationId: orgId } });
      await record(req, 'property.created', 'property', p.id, { name: p.name }, tx);
      return p;
    });
    sendData(res, serializeProperty(created), 201);
  });

  r.get('/:propertyId', requireOrgPermission('property.read'), async (req, res) => {
    const id = param(req, 'propertyId');
    const p = await tenant(req, async (tx) => {
      const property = await loadProperty(tx, id);
      const roomTypes = await tx.roomType.findMany({
        where: { propertyId: id },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { rooms: true } } },
      });
      return { property, roomTypes };
    });
    sendData(res, {
      ...serializeProperty(p.property),
      roomTypes: p.roomTypes.map(({ _count, ...rt }) => ({ ...serializeRoomType(rt), roomCount: _count.rooms })),
    });
  });

  r.patch('/:propertyId', requireOrgPermission('property.write'), async (req, res) => {
    const id = param(req, 'propertyId');
    const body = parseBody(UpdatePropertyBody, req);
    const updated = await tenant(req, async (tx) => {
      await loadProperty(tx, id);
      const p = await tx.property.update({ where: { id }, data: body });
      await record(req, 'property.updated', 'property', id, { fields: Object.keys(body) }, tx);
      return p;
    });
    sendData(res, serializeProperty(updated));
  });

  r.delete('/:propertyId', requireOrgPermission('property.write'), async (req, res) => {
    const id = param(req, 'propertyId');
    await tenant(req, async (tx) => {
      const p = await loadProperty(tx, id);
      if ((await tx.roomType.count({ where: { propertyId: id } })) > 0) {
        throw new AppError(409, 'PROPERTY_IN_USE', 'Delete its room types first, or set the property to Inactive.');
      }
      await tx.property.delete({ where: { id } });
      await record(req, 'property.deleted', 'property', id, { name: p.name }, tx);
    });
    sendData(res, { status: 'deleted' });
  });

  // --- room types ------------------------------------------------------------------

  r.get('/:propertyId/room-types', requireOrgPermission('property.read'), async (req, res) => {
    const id = param(req, 'propertyId');
    const list = await tenant(req, async (tx) => {
      await loadProperty(tx, id);
      return tx.roomType.findMany({ where: { propertyId: id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { rooms: true } } } });
    });
    sendData(
      res,
      list.map(({ _count, ...rt }) => ({ ...serializeRoomType(rt), roomCount: _count.rooms })),
    );
  });

  r.post('/:propertyId/room-types', requireOrgPermission('property.write'), async (req, res) => {
    const id = param(req, 'propertyId');
    const body = parseBody(CreateRoomTypeBody, req);
    const created = await tenant(req, async (tx) => {
      await loadProperty(tx, id);
      const rt = await tx.roomType.create({ data: { ...body, organizationId: req.org!.organizationId, propertyId: id } });
      await record(req, 'room_type.created', 'room_type', rt.id, { propertyId: id, code: rt.code }, tx);
      return rt;
    });
    sendData(res, serializeRoomType(created), 201);
  });

  r.patch('/:propertyId/room-types/:roomTypeId', requireOrgPermission('property.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const id = param(req, 'roomTypeId');
    const body = parseBody(UpdateRoomTypeBody, req);
    const updated = await tenant(req, async (tx) => {
      const current = await tx.roomType.findFirst({ where: { id, propertyId } });
      if (!current) throw new NotFoundError('Room type not found');
      const merged = { ...current, ...body };
      if (merged.maxOccupancy < merged.baseOccupancy || merged.maxOccupancy > merged.maxAdults + merged.maxChildren) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Max occupancy must be at least the base occupancy and at most adults + children');
      }
      const rt = await tx.roomType.update({ where: { id }, data: body });
      await record(req, 'room_type.updated', 'room_type', id, { fields: Object.keys(body) }, tx);
      return rt;
    });
    sendData(res, serializeRoomType(updated));
  });

  r.delete('/:propertyId/room-types/:roomTypeId', requireOrgPermission('property.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const id = param(req, 'roomTypeId');
    await tenant(req, async (tx) => {
      const rt = await tx.roomType.findFirst({ where: { id, propertyId } });
      if (!rt) throw new NotFoundError('Room type not found');
      if ((await tx.room.count({ where: { roomTypeId: id } })) > 0) {
        throw new AppError(409, 'ROOM_TYPE_IN_USE', 'Delete or move its rooms first, or set the room type to Inactive.');
      }
      if ((await tx.channelRoomMapping.count({ where: { roomTypeId: id } })) > 0) {
        throw new AppError(409, 'ROOM_TYPE_MAPPED', 'This room type is mapped to a booking channel. Remove it from the channel mapping first.');
      }
      if ((await tx.reservationRoom.count({ where: { roomTypeId: id } })) > 0) {
        throw new AppError(409, 'ROOM_TYPE_HAS_BOOKINGS', 'This room type has bookings, so it cannot be deleted. Set it to Inactive instead.');
      }
      // Calendar rows of a room type without rooms carry no information; remove them with it.
      await tx.inventoryDay.deleteMany({ where: { roomTypeId: id } });
      await tx.rateDay.deleteMany({ where: { roomTypeId: id } });
      await tx.roomType.delete({ where: { id } });
      await record(req, 'room_type.deleted', 'room_type', id, { code: rt.code }, tx);
    });
    sendData(res, { status: 'deleted' });
  });

  // --- rooms / units ------------------------------------------------------------------

  r.get('/:propertyId/rooms', requireOrgPermission('property.read'), async (req, res) => {
    const id = param(req, 'propertyId');
    const list = await tenant(req, async (tx) => {
      await loadProperty(tx, id);
      return tx.room.findMany({ where: { propertyId: id }, orderBy: [{ name: 'asc' }], include: { roomType: { select: { id: true, name: true, code: true } } } });
    });
    sendData(res, list);
  });

  r.post('/:propertyId/rooms', requireOrgPermission('property.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const body = parseBody(CreateRoomBody, req);
    const created = await tenant(req, async (tx) => {
      await loadProperty(tx, propertyId);
      // The (property, room type) foreign key also rejects a room type from another property.
      const room = await tx.room.create({ data: { ...body, organizationId: req.org!.organizationId, propertyId } });
      await record(req, 'room.created', 'room', room.id, { propertyId, name: room.name }, tx);
      await enqueueAvailabilityResync(tx, req.org!.organizationId, propertyId, [room.roomTypeId]);
      return room;
    });
    sendData(res, created, 201);
  });

  r.post('/:propertyId/rooms/bulk', requireOrgPermission('property.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const body = parseBody(BulkCreateRoomsBody, req);
    const count = await tenant(req, async (tx) => {
      await loadProperty(tx, propertyId);
      const result = await tx.room.createMany({
        data: body.names.map((name) => ({ name, floor: body.floor ?? null, roomTypeId: body.roomTypeId, organizationId: req.org!.organizationId, propertyId })),
      });
      await record(req, 'room.bulk_created', 'property', propertyId, { count: result.count, roomTypeId: body.roomTypeId }, tx);
      await enqueueAvailabilityResync(tx, req.org!.organizationId, propertyId, [body.roomTypeId]);
      return result.count;
    });
    sendData(res, { created: count }, 201);
  });

  r.patch('/:propertyId/rooms/:roomId', requireOrgPermission('property.read'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const id = param(req, 'roomId');
    const body = parseBody(UpdateRoomBody, req);
    // Staff with inventory.write may only change status (e.g. mark out of service).
    const onlyStatus = Object.keys(body).every((k) => k === 'status');
    const role = req.org!.role;
    if (!orgRoleHas(role, 'property.write') && !(onlyStatus && orgRoleHas(role, 'inventory.write'))) {
      throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this action.');
    }
    const updated = await tenant(req, async (tx) => {
      const room = await tx.room.findFirst({ where: { id, propertyId } });
      if (!room) throw new NotFoundError('Room not found');
      const u = await tx.room.update({ where: { id }, data: body });
      await record(req, 'room.updated', 'room', id, { fields: Object.keys(body), ...(body.status ? { status: body.status } : {}) }, tx);
      if (body.status !== undefined || body.roomTypeId !== undefined) {
        await enqueueAvailabilityResync(tx, req.org!.organizationId, propertyId, [...new Set([room.roomTypeId, u.roomTypeId])]);
      }
      return u;
    });
    sendData(res, updated);
  });

  r.delete('/:propertyId/rooms/:roomId', requireOrgPermission('property.write'), async (req, res) => {
    const propertyId = param(req, 'propertyId');
    const id = param(req, 'roomId');
    await tenant(req, async (tx) => {
      const room = await tx.room.findFirst({ where: { id, propertyId } });
      if (!room) throw new NotFoundError('Room not found');
      await tx.room.delete({ where: { id } });
      await record(req, 'room.deleted', 'room', id, { name: room.name }, tx);
      await enqueueAvailabilityResync(tx, req.org!.organizationId, propertyId, [room.roomTypeId]);
    });
    sendData(res, { status: 'deleted' });
  });

  return r;
}
