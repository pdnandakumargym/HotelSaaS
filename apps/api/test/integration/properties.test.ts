import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { createHarness, type Client, type Harness } from './harness.js';

let h: Harness;
let owner: Client;
let orgId: string;
let otherOrgId: string;
let otherOwner: Client;

const baseProperty = { name: 'Sea View Villa', propertyType: 'VILLA', timezone: 'Asia/Kolkata', currency: 'inr', countryCode: 'in' };

async function setPlan(organizationId: string, code: string) {
  await withSystem(h.db, async (tx) => {
    const plan = await tx.plan.findUniqueOrThrow({ where: { code } });
    await tx.subscription.update({ where: { organizationId }, data: { planId: plan.id, status: 'ACTIVE' } });
  });
}

beforeAll(async () => {
  h = await createHarness();
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  const o = await h.createUser();
  otherOrgId = o.organizationId!;
  otherOwner = h.client();
  await otherOwner.login(o.email, o.password);
  await setPlan(orgId, 'PRO');
});
afterAll(async () => {
  await h.close();
});

describe('properties CRUD', () => {
  let propertyId: string;

  it('creates a property with normalized and validated fields', async () => {
    const res = await owner.post(`/organizations/${orgId}/properties`, {
      ...baseProperty,
      checkInTime: '14:00',
      checkOutTime: '11:00',
      starRating: 4,
      amenities: ['WIFI', 'POOL', 'WIFI'],
      latitude: 12.9716,
      longitude: 80.2468,
      contactEmail: 'stay@example.test',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ currency: 'INR', countryCode: 'IN', status: 'DRAFT', amenities: ['WIFI', 'POOL'], latitude: 12.9716 });
    propertyId = res.body.data.id;
  });

  it.each([
    [{ timezone: 'Mars/Base' }, 'timezone'],
    [{ currency: 'XYZ' }, 'currency'],
    [{ countryCode: 'ZZ' }, 'countryCode'],
    [{ checkInTime: '25:00' }, 'checkInTime'],
    [{ starRating: 7 }, 'starRating'],
    [{ amenities: ['MINIBAR'] }, 'amenities'], // room-only amenity
    [{ unexpected: true }, ''],
  ])('rejects invalid input %j', async (override, field) => {
    const res = await owner.post(`/organizations/${orgId}/properties`, { ...baseProperty, name: `Bad ${Math.random()}`, ...override });
    expect(res.status).toBe(400);
    if (field) expect(JSON.stringify(res.body.error.details)).toContain(field);
  });

  it('rejects a duplicate name in the same organization with 409', async () => {
    const res = await owner.post(`/organizations/${orgId}/properties`, baseProperty);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_EXISTS');
  });

  it('lists, reads and updates', async () => {
    const list = await owner.get(`/organizations/${orgId}/properties`);
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(propertyId);
    const upd = await owner.send('patch', `/organizations/${orgId}/properties/${propertyId}`, { status: 'ACTIVE', houseRules: 'No parties.' });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ status: 'ACTIVE', houseRules: 'No parties.' });
    const one = await owner.get(`/organizations/${orgId}/properties/${propertyId}`);
    expect(one.body.data.roomTypes).toEqual([]);
  });

  it('enforces the plan property limit in the API', async () => {
    await setPlan(orgId, 'FREE');
    const res = await owner.post(`/organizations/${orgId}/properties`, { ...baseProperty, name: 'Second property' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    await setPlan(orgId, 'PRO');
    expect((await owner.post(`/organizations/${orgId}/properties`, { ...baseProperty, name: 'Second property' })).status).toBe(201);
  });

  it('hides another tenant’s property (404) for read, update and delete', async () => {
    expect((await otherOwner.get(`/organizations/${otherOrgId}/properties/${propertyId}`)).status).toBe(404);
    expect((await otherOwner.send('patch', `/organizations/${otherOrgId}/properties/${propertyId}`, { name: 'Hijack' })).status).toBe(404);
    expect((await otherOwner.send('delete', `/organizations/${otherOrgId}/properties/${propertyId}`)).status).toBe(404);
    expect((await otherOwner.get(`/organizations/${orgId}/properties/${propertyId}`)).status).toBe(404);
  });

  it('audits property changes', async () => {
    const events = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, entityId: propertyId } }));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['property.created', 'property.updated']));
  });

  describe('room types and rooms', () => {
    let roomTypeId: string;

    it('creates a room type with occupancy rules', async () => {
      const bad = await owner.post(`/organizations/${orgId}/properties/${propertyId}/room-types`, {
        name: 'Broken',
        code: 'BRK',
        baseOccupancy: 3,
        maxAdults: 2,
        maxChildren: 0,
        maxOccupancy: 2,
      });
      expect(bad.status).toBe(400);
      const res = await owner.post(`/organizations/${orgId}/properties/${propertyId}/room-types`, {
        name: 'Deluxe Room',
        code: 'dlx',
        baseOccupancy: 2,
        maxAdults: 2,
        maxChildren: 1,
        maxOccupancy: 3,
        amenities: ['AIR_CONDITIONING', 'SEA_VIEW'],
        sizeSqm: 28.5,
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ code: 'DLX', sizeSqm: 28.5 });
      roomTypeId = res.body.data.id;
    });

    it('rejects duplicate room type codes per property', async () => {
      const res = await owner.post(`/organizations/${orgId}/properties/${propertyId}/room-types`, { name: 'Deluxe 2', code: 'DLX' });
      expect(res.status).toBe(409);
    });

    it('creates rooms singly and in bulk, and rejects duplicates', async () => {
      expect((await owner.post(`/organizations/${orgId}/properties/${propertyId}/rooms`, { roomTypeId, name: '101', floor: '1' })).status).toBe(201);
      const bulk = await owner.post(`/organizations/${orgId}/properties/${propertyId}/rooms/bulk`, { roomTypeId, names: ['102', '103', '104'] });
      expect(bulk.body.data.created).toBe(3);
      expect((await owner.post(`/organizations/${orgId}/properties/${propertyId}/rooms`, { roomTypeId, name: '101' })).status).toBe(409);
      const list = await owner.get(`/organizations/${orgId}/properties/${propertyId}/rooms`);
      expect(list.body.data.map((r: { name: string }) => r.name)).toEqual(['101', '102', '103', '104']);
    });

    it('rejects a room type from a different property', async () => {
      const other = await owner.post(`/organizations/${orgId}/properties`, { ...baseProperty, name: 'Third' });
      const otherId = other.body.data.id as string;
      const res = await owner.post(`/organizations/${orgId}/properties/${otherId}/rooms`, { roomTypeId, name: 'X1' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REFERENCE_INVALID');
    });

    it('lets staff change room status but nothing else', async () => {
      const staff = await h.createUser({ role: 'PROPERTY_STAFF', organizationId: orgId });
      const c = h.client();
      await c.login(staff.email, staff.password);
      const rooms = await c.get(`/organizations/${orgId}/properties/${propertyId}/rooms`);
      const roomId = rooms.body.data[0].id as string;
      expect((await c.send('patch', `/organizations/${orgId}/properties/${propertyId}/rooms/${roomId}`, { status: 'OUT_OF_SERVICE' })).status).toBe(200);
      expect((await c.send('patch', `/organizations/${orgId}/properties/${propertyId}/rooms/${roomId}`, { name: 'Renamed' })).status).toBe(403);
      expect((await c.post(`/organizations/${orgId}/properties/${propertyId}/room-types`, { name: 'Staff type', code: 'STF' })).status).toBe(403);
      expect((await c.post(`/organizations/${orgId}/properties`, { ...baseProperty, name: 'Staff property' })).status).toBe(403);
    });

    it('lets read-only viewers read but not write', async () => {
      const viewer = await h.createUser({ role: 'READ_ONLY', organizationId: orgId });
      const c = h.client();
      await c.login(viewer.email, viewer.password);
      expect((await c.get(`/organizations/${orgId}/properties/${propertyId}/room-types`)).status).toBe(200);
      const rooms = await c.get(`/organizations/${orgId}/properties/${propertyId}/rooms`);
      const roomId = rooms.body.data[0].id as string;
      expect((await c.send('patch', `/organizations/${orgId}/properties/${propertyId}/rooms/${roomId}`, { status: 'AVAILABLE' })).status).toBe(403);
    });

    it('protects referenced records from deletion', async () => {
      const delType = await owner.send('delete', `/organizations/${orgId}/properties/${propertyId}/room-types/${roomTypeId}`);
      expect(delType.status).toBe(409);
      expect(delType.body.error.code).toBe('ROOM_TYPE_IN_USE');
      const delProp = await owner.send('delete', `/organizations/${orgId}/properties/${propertyId}`);
      expect(delProp.body.error.code).toBe('PROPERTY_IN_USE');
    });

    it('deletes rooms, then the room type, then the property', async () => {
      const rooms = await owner.get(`/organizations/${orgId}/properties/${propertyId}/rooms`);
      for (const r of rooms.body.data as { id: string }[]) {
        expect((await owner.send('delete', `/organizations/${orgId}/properties/${propertyId}/rooms/${r.id}`)).status).toBe(200);
      }
      expect((await owner.send('delete', `/organizations/${orgId}/properties/${propertyId}/room-types/${roomTypeId}`)).status).toBe(200);
      expect((await owner.send('delete', `/organizations/${orgId}/properties/${propertyId}`)).status).toBe(200);
      expect((await owner.get(`/organizations/${orgId}/properties/${propertyId}`)).status).toBe(404);
    });
  });

  it('serves the amenity catalog', async () => {
    const res = await owner.get('/amenities');
    expect(res.body.data.find((a: { code: string }) => a.code === 'WIFI')).toMatchObject({ scope: 'both' });
  });
});
