import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../src/infrastructure/db/tenant.js';
import { createHarness, ORIGIN, type Client, type Harness } from './harness.js';

/** Photo upload: real decoding and re-encoding with sharp, tenant isolation, signed links. */
let h: Harness;
let owner: Client;
let orgId: string;
let propertyId: string;
let roomTypeId: string;
const base = () => `/organizations/${orgId}/properties/${propertyId}/photos`;

async function jpegWithGps(w = 1200, h2 = 800, color = '#3366cc') {
  // An EXIF block with a GPS position that must not survive the upload.
  return sharp({ create: { width: w, height: h2, channels: 3, background: color } })
    .withExif({ IFD0: { Artist: 'Secret Photographer' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '11/1 24/1 0/1' } })
    .jpeg()
    .toBuffer();
}
function upload(c: Client, body: Buffer, type = 'image/jpeg', query = '') {
  return request(h.app)
    .post(`/api/v1${base()}${query}`)
    .set('Origin', ORIGIN)
    .set('Cookie', `ss_session=${c.sessionToken}; ss_csrf=${c.csrf}`)
    .set('X-CSRF-Token', c.csrf ?? '')
    .set('Content-Type', type)
    .send(body);
}

beforeAll(async () => {
  h = await createHarness();
  const u = await h.createUser();
  orgId = u.organizationId!;
  owner = h.client();
  await owner.login(u.email, u.password);
  propertyId = (await owner.post(`/organizations/${orgId}/properties`, { name: 'Photo Villa', propertyType: 'VILLA', timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN' })).body.data.id;
  roomTypeId = (await owner.post(`/organizations/${orgId}/properties/${propertyId}/room-types`, { name: 'Garden Room', code: 'GRD' })).body.data.id;
});
afterAll(async () => {
  await h.close();
});

describe('photo upload', () => {
  let firstId: string;

  it('re-encodes an upload to JPEG, removes metadata and makes the first photo the main one', async () => {
    const res = await upload(owner, await jpegWithGps());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ width: 1200, height: 800, contentType: 'image/jpeg', isMain: true, roomTypeId: null });
    expect(res.body.data.storageKey).toBeUndefined();
    expect(res.body.data.sha256).toBeUndefined();
    firstId = res.body.data.id;
    const file = await owner.get(`${base()}/${firstId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toContain('private');
    const meta = await sharp(file.body as Buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect((file.body as Buffer).toString('latin1')).not.toContain('Secret Photographer');
  });

  it('accepts PNG and WebP, scales large photos down and stores them as JPEG', async () => {
    const png = await sharp({ create: { width: 4000, height: 3000, channels: 4, background: { r: 10, g: 200, b: 10, alpha: 0.5 } } }).png().toBuffer();
    const r1 = await upload(owner, png, 'image/png', `?roomTypeId=${roomTypeId}`);
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({ width: 2560, height: 1920, roomTypeId, isMain: true });
    const webp = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#aa2200' } }).webp().toBuffer();
    expect((await upload(owner, webp, 'image/webp')).body.data).toMatchObject({ isMain: false, sortOrder: 1 });
  });

  it('rejects files that are not images, too small, too large, duplicates, or for another property', async () => {
    expect((await upload(owner, Buffer.from('<svg onload=alert(1)></svg>'), 'image/png')).body.error.code).toBe('UNSUPPORTED_IMAGE');
    expect((await upload(owner, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]))).body.error.code).toBe('INVALID_IMAGE');
    const tiny = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    expect((await upload(owner, tiny)).body.error.code).toBe('IMAGE_TOO_SMALL');
    expect((await upload(owner, await jpegWithGps())).body.error.code).toBe('DUPLICATE_PHOTO');
    expect((await upload(owner, Buffer.alloc(11 * 1024 * 1024, 1))).status).toBe(413);
    expect((await upload(owner, await jpegWithGps(800, 600), 'image/gif')).status).toBeGreaterThanOrEqual(400);
    expect((await upload(owner, await jpegWithGps(800, 600, '#123456'), 'image/jpeg', '?roomTypeId=00000000-0000-7000-8000-000000000000')).body.error.code).toBe('UNKNOWN_ROOM_TYPE');
  });

  it('lists, captions, changes the main photo, reorders and deletes', async () => {
    const list = await owner.get(base());
    expect(list.body.data).toHaveLength(3);
    const second = list.body.data.find((p: { roomTypeId: string | null; isMain: boolean }) => p.roomTypeId === null && !p.isMain);
    const r = await owner.send('patch', `${base()}/${second.id}`, { caption: 'Pool at sunset', isMain: true, sortOrder: 0 });
    expect(r.body.data).toMatchObject({ caption: 'Pool at sunset', isMain: true, sortOrder: 0 });
    const after = await owner.get(base());
    expect(after.body.data.filter((p: { roomTypeId: string | null; isMain: boolean }) => p.roomTypeId === null && p.isMain)).toHaveLength(1);
    expect((await owner.send('patch', `${base()}/${second.id}`, { storageKey: 'x' })).status).toBe(400);
    // Deleting the main photo promotes the next one.
    expect((await owner.send('delete', `${base()}/${second.id}`)).status).toBe(200);
    const final = await owner.get(base());
    expect(final.body.data.find((p: { id: string }) => p.id === firstId).isMain).toBe(true);
    expect((await owner.get(`${base()}/${second.id}/file`)).status).toBe(404);
    const audit = await withSystem(h.db, (tx) => tx.auditEvent.findMany({ where: { organizationId: orgId, entityType: 'photo' }, select: { action: true } }));
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(['photo.uploaded', 'photo.updated', 'photo.deleted']));
  });

  it('keeps photos inside the organization and enforces roles', async () => {
    const other = await h.createUser();
    const oc = h.client();
    await oc.login(other.email, other.password);
    expect((await oc.get(base())).status).toBe(404);
    expect((await oc.get(`${base()}/${firstId}/file`)).status).toBe(404);
    expect((await oc.get(`/organizations/${other.organizationId}/properties/${propertyId}/photos/${firstId}/file`)).status).toBe(404);
    const ro = await h.createUser({ role: 'READ_ONLY', organizationId: orgId });
    const rc = h.client();
    await rc.login(ro.email, ro.password);
    expect((await rc.get(base())).status).toBe(200);
    expect((await upload(rc, await jpegWithGps(900, 700, '#00ff00'))).status).toBe(403);
    expect((await rc.send('delete', `${base()}/${firstId}`)).status).toBe(403);
    // Anonymous
    expect((await request(h.app).get(`/api/v1${base()}/${firstId}/file`)).status).toBe(401);
  });

  it('serves a photo through a signed, expiring link only', async () => {
    expect(h.services.photos.signedUrl(firstId)).toBeNull(); // no PUBLIC_MEDIA_BASE_URL in tests
    const withBase = await createHarness({ PUBLIC_MEDIA_BASE_URL: 'https://media.example.test' });
    try {
      const url = withBase.services.photos.signedUrl(firstId)!;
      expect(url).toMatch(/^https:\/\/media\.example\.test\/api\/v1\/media\/photos\/[0-9a-f-]{36}\.jpg\?exp=\d+&sig=[0-9a-f]{64}$/);
      const path = url.replace('https://media.example.test', '');
      const ok = await request(withBase.app).get(path).buffer(true);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toBe('image/jpeg');
      expect(ok.headers['cache-control']).toContain('public');
      expect((await request(withBase.app).get(path.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).status).toBe(404);
      expect((await request(withBase.app).get(path.replace(/exp=\d+/, 'exp=1000'))).status).toBe(404);
      expect((await request(withBase.app).get(`/api/v1/media/photos/${firstId}.jpg`)).status).toBe(404);
    } finally {
      await withBase.close();
    }
  });
});
