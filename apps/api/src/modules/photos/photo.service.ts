import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../infrastructure/db/prisma.js';
import { withSystem, withTenant } from '../../infrastructure/db/tenant.js';
import { deriveKey, hmacHex, safeEqualHex } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { processImage } from './image.js';
import type { PhotoStorage } from './storage.js';

export const MAX_PHOTOS_PER_PROPERTY = 100;
/** Signed links for channels stay valid this long (Booking.com downloads asynchronously). */
const LINK_TTL_SECONDS = 7 * 24 * 3600;

export interface PhotoUpdate {
  caption?: string | null;
  isMain?: boolean;
  sortOrder?: number;
}

/**
 * Property and room-type photos. Uploads are re-encoded (metadata removed) and stored under random keys;
 * files are served to signed-in members of the organization, and to channels only through signed, expiring links.
 */
export class PhotoService {
  private readonly linkKey: Buffer;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly storage: PhotoStorage,
    private readonly audit: AuditService,
    private readonly logger: Logger,
  ) {
    this.linkKey = deriveKey(config.auth.dataEncryptionKey, 'photo-link-signing');
  }

  list(organizationId: string, propertyId: string) {
    return withTenant(this.db, organizationId, async (tx) => {
      const p = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true } });
      if (!p) throw new AppError(404, 'NOT_FOUND', 'Property not found');
      return tx.photo.findMany({ where: { propertyId }, orderBy: [{ roomTypeId: { sort: 'asc', nulls: 'first' } }, { isMain: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] });
    });
  }

  async upload(organizationId: string, propertyId: string, roomTypeId: string | null, input: Buffer, actor: { id: string }, meta: RequestMeta) {
    if (!input.length) throw new AppError(400, 'EMPTY_FILE', 'Choose a photo to upload.');
    if (input.length > this.config.photos.maxUploadBytes) throw new AppError(413, 'FILE_TOO_LARGE', `Photos can be at most ${Math.round(this.config.photos.maxUploadBytes / 1048576)} MB.`);
    const img = await processImage(input);
    const sha256 = createHash('sha256').update(img.data).digest('hex');
    const storageKey = `${randomUUID()}.jpg`;

    // Validate first, then write the file, then commit the row; a failed commit removes the file again.
    await withTenant(this.db, organizationId, async (tx) => {
      const p = await tx.property.findUnique({ where: { id: propertyId }, select: { id: true } });
      if (!p) throw new AppError(404, 'NOT_FOUND', 'Property not found');
      if (roomTypeId && !(await tx.roomType.findFirst({ where: { id: roomTypeId, propertyId }, select: { id: true } }))) {
        throw new AppError(400, 'UNKNOWN_ROOM_TYPE', 'The room type does not belong to this property.');
      }
      if ((await tx.photo.count({ where: { propertyId } })) >= MAX_PHOTOS_PER_PROPERTY) throw new AppError(409, 'PHOTO_LIMIT', `A property can have at most ${MAX_PHOTOS_PER_PROPERTY} photos.`);
      if (await tx.photo.findFirst({ where: { propertyId, roomTypeId, sha256 }, select: { id: true } })) throw new AppError(409, 'DUPLICATE_PHOTO', 'This photo is already uploaded here.');
    });
    await this.storage.put(storageKey, img.data);
    try {
      return await withTenant(this.db, organizationId, async (tx) => {
        const existing = await tx.photo.count({ where: { propertyId, roomTypeId } });
        const photo = await tx.photo.create({
          data: {
            organizationId,
            propertyId,
            roomTypeId,
            storageKey,
            contentType: 'image/jpeg',
            width: img.width,
            height: img.height,
            bytes: img.data.length,
            sha256,
            isMain: existing === 0,
            sortOrder: existing,
            createdById: actor.id,
          },
        });
        await this.audit.record({ action: 'photo.uploaded', organizationId, actorUserId: actor.id, entityType: 'photo', entityId: photo.id, metadata: { propertyId, roomTypeId, bytes: img.data.length }, ...meta }, tx);
        return photo;
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  update(organizationId: string, propertyId: string, id: string, u: PhotoUpdate, actor: { id: string }, meta: RequestMeta) {
    return withTenant(this.db, organizationId, async (tx) => {
      const photo = await tx.photo.findFirst({ where: { id, propertyId } });
      if (!photo) throw new AppError(404, 'NOT_FOUND', 'Photo not found');
      if (u.isMain) await tx.photo.updateMany({ where: { propertyId, roomTypeId: photo.roomTypeId, isMain: true, NOT: { id } }, data: { isMain: false } });
      const updated = await tx.photo.update({
        where: { id },
        data: {
          ...(u.caption !== undefined ? { caption: u.caption } : {}),
          ...(u.isMain !== undefined ? { isMain: u.isMain } : {}),
          ...(u.sortOrder !== undefined ? { sortOrder: u.sortOrder } : {}),
        },
      });
      await this.audit.record({ action: 'photo.updated', organizationId, actorUserId: actor.id, entityType: 'photo', entityId: id, metadata: { fields: Object.keys(u) }, ...meta }, tx);
      return updated;
    });
  }

  async remove(organizationId: string, propertyId: string, id: string, actor: { id: string }, meta: RequestMeta): Promise<void> {
    const key = await withTenant(this.db, organizationId, async (tx) => {
      const photo = await tx.photo.findFirst({ where: { id, propertyId } });
      if (!photo) throw new AppError(404, 'NOT_FOUND', 'Photo not found');
      await tx.photo.delete({ where: { id } });
      if (photo.isMain) {
        const next = await tx.photo.findFirst({ where: { propertyId, roomTypeId: photo.roomTypeId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
        if (next) await tx.photo.update({ where: { id: next.id }, data: { isMain: true } });
      }
      await this.audit.record({ action: 'photo.deleted', organizationId, actorUserId: actor.id, entityType: 'photo', entityId: id, metadata: { propertyId }, ...meta }, tx);
      return photo.storageKey;
    });
    await this.storage.delete(key).catch((err: unknown) => this.logger.warn({ err: (err as Error).message, photoId: id }, 'could not delete photo file'));
  }

  /** File for a signed-in member (tenant-scoped lookup). */
  async file(organizationId: string, propertyId: string, id: string): Promise<Buffer> {
    const photo = await withTenant(this.db, organizationId, (tx) => tx.photo.findFirst({ where: { id, propertyId }, select: { storageKey: true } }));
    if (!photo) throw new AppError(404, 'NOT_FOUND', 'Photo not found');
    return this.read(photo.storageKey);
  }

  /** A row whose file went missing (e.g. storage folder moved) is reported as not found, and logged. */
  private async read(key: string): Promise<Buffer> {
    try {
      return await this.storage.get(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.logger.error({ storageKey: key }, 'photo file missing from storage');
      throw new AppError(404, 'NOT_FOUND', 'Photo file not found');
    }
  }

  // --- signed links for channels -----------------------------------------------------------------

  private sign(id: string, exp: number): string {
    return hmacHex(this.linkKey, `${id}.${exp}`);
  }

  /** Public, expiring link a channel can download. Null when no public base URL is configured. */
  signedUrl(id: string, now = Date.now()): string | null {
    const base = this.config.photos.publicBaseUrl;
    if (!base) return null;
    const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
    return `${base}/api/v1/media/photos/${id}.jpg?exp=${exp}&sig=${this.sign(id, exp)}`;
  }

  /** Verifies a signed link and returns the file; any problem is a plain 404 (nothing to probe). */
  async signedFile(id: string, exp: string, sig: string, now = Date.now()): Promise<Buffer> {
    const e = Number(exp);
    if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig) || e < Math.floor(now / 1000) || !safeEqualHex(this.sign(id, e), sig)) {
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    }
    const photo = await withSystem(this.db, (tx) => tx.photo.findUnique({ where: { id }, select: { storageKey: true } }));
    if (!photo) throw new AppError(404, 'NOT_FOUND', 'Not found');
    return this.read(photo.storageKey);
  }
}
