import express, { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { errorBody } from '../../shared/http.js';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOrgPermission } from '../../middleware/org-access.js';
import { registry } from '../../openapi/registry.js';
import { AppError } from '../../shared/errors.js';
import { sendData } from '../../shared/http.js';
import { parseBody, parseQuery } from '../../shared/validate.js';
import { requestMeta } from '../auth/auth.routes.js';
import type { PhotoService } from './photo.service.js';

for (const [method, path, summary] of [
  ['get', '/organizations/{orgId}/properties/{propertyId}/photos', 'Photos of a property and its room types'],
  ['post', '/organizations/{orgId}/properties/{propertyId}/photos', 'Upload one photo (raw image/jpeg, image/png or image/webp body; ?roomTypeId= for a room type)'],
  ['patch', '/organizations/{orgId}/properties/{propertyId}/photos/{photoId}', 'Caption, main photo, order'],
  ['delete', '/organizations/{orgId}/properties/{propertyId}/photos/{photoId}', 'Delete a photo'],
  ['get', '/organizations/{orgId}/properties/{propertyId}/photos/{photoId}/file', 'Photo file (signed-in members)'],
  ['get', '/media/photos/{photoId}.jpg', 'Photo file through a signed, expiring link (for channels)'],
] as const) {
  registry.registerPath({ method, path: `/api/v1${path}`, tags: ['Photos'], summary, responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(v: unknown): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(404, 'NOT_FOUND', 'Not found');
  return v;
}
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const UpdateBody = z
  .object({
    caption: z.preprocess(blankToNull, z.string().trim().max(200).nullable().optional()),
    isMain: z.literal(true).optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
const UploadQuery = z.object({ roomTypeId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()) });

type PhotoRow = { id: string; storageKey: string; sha256: string; organizationId: string; updatedAt: Date };
/** API view of a photo: never the storage key, file hash or tenant id. */
function view<T extends PhotoRow>(p: T, orgId: string, propertyId: string) {
  const out: Record<string, unknown> = { ...p };
  delete out['storageKey'];
  delete out['sha256'];
  delete out['organizationId'];
  return { ...(out as Omit<T, 'storageKey' | 'sha256' | 'organizationId'>), url: `/api/v1/organizations/${orgId}/properties/${propertyId}/photos/${p.id}/file?v=${p.updatedAt.getTime()}` };
}

function sendJpeg(res: Response, data: Buffer, cache: string): void {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('Cache-Control', cache);
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.end(data);
}

/** Mounted at /organizations/:orgId/properties/:propertyId/photos. */
export function photosRouter(deps: { photos: PhotoService; config: AppConfig }): Router {
  const { photos, config } = deps;
  const r = Router({ mergeParams: true });
  r.use(requireAuth());
  const ids = (req: Request) => ({ orgId: req.org!.organizationId, propertyId: uuidParam(req.params['propertyId']) });

  r.get('/', requireOrgPermission('property.read'), async (req, res) => {
    const { orgId, propertyId } = ids(req);
    const list = await photos.list(orgId, propertyId);
    sendData(res, list.map((p) => view(p, orgId, propertyId)));
  });

  // Decoding images is CPU-heavy: at most 60 uploads per user per 10 minutes.
  const uploadLimit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: 'photo-upload',
    keyGenerator: (req) => `user:${req.auth?.user.id ?? 'anon'}`,
    handler: (req, res) => {
      res.status(429).json(errorBody('RATE_LIMITED', 'Too many uploads. Please wait a few minutes and try again.', req.requestId));
    },
  });

  r.post(
    '/',
    requireOrgPermission('property.write'),
    uploadLimit,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: config.photos.maxUploadBytes }),
    async (req, res) => {
      const { orgId, propertyId } = ids(req);
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Upload a JPEG, PNG or WebP photo.');
      const { roomTypeId } = parseQuery(UploadQuery, req);
      const p = await photos.upload(orgId, propertyId, roomTypeId ?? null, req.body, req.auth!.user, requestMeta(req));
      sendData(res, view(p, orgId, propertyId), 201);
    },
  );

  r.patch('/:photoId', requireOrgPermission('property.write'), async (req, res) => {
    const { orgId, propertyId } = ids(req);
    const p = await photos.update(orgId, propertyId, uuidParam(req.params['photoId']), parseBody(UpdateBody, req), req.auth!.user, requestMeta(req));
    sendData(res, view(p, orgId, propertyId));
  });

  r.delete('/:photoId', requireOrgPermission('property.write'), async (req, res) => {
    const { orgId, propertyId } = ids(req);
    await photos.remove(orgId, propertyId, uuidParam(req.params['photoId']), req.auth!.user, requestMeta(req));
    sendData(res, { status: 'deleted' });
  });

  r.get('/:photoId/file', requireOrgPermission('property.read'), async (req, res) => {
    const { orgId, propertyId } = ids(req);
    sendJpeg(res, await photos.file(orgId, propertyId, uuidParam(req.params['photoId'])), 'private, max-age=3600');
  });
  return r;
}

/** Mounted at /media (no session needed: access is proven by the link's signature and expiry). */
export function mediaRouter(photos: PhotoService): Router {
  const r = Router();
  r.get('/photos/:file', async (req, res) => {
    const m = /^([0-9a-f-]{36})\.jpg$/i.exec(String(req.params['file']));
    if (!m) throw new AppError(404, 'NOT_FOUND', 'Not found');
    const data = await photos.signedFile(uuidParam(m[1]), typeof req.query['exp'] === 'string' ? req.query['exp'] : '', typeof req.query['sig'] === 'string' ? req.query['sig'] : '');
    sendJpeg(res, data, 'public, max-age=3600');
  });
  return r;
}
