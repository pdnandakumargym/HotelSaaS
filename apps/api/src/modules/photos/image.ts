import sharp, { type Metadata } from 'sharp';
import { AppError } from '../../shared/errors.js';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Identifies the real file type from its first bytes (the Content-Type header and file name are not trusted). */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const MAX_EDGE = 2560;
export const MIN_EDGE = 320;
const MAX_INPUT_PIXELS = 50_000_000;

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Decodes and re-encodes an uploaded photo. Re-encoding drops everything except the pixels: EXIF (including GPS
 * position), ICC tricks, embedded scripts or trailing data. The photo is turned upright, scaled to at most
 * 2560 px on the long edge, and stored as a progressive JPEG.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (!detectImageType(input)) throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Upload a JPEG, PNG or WebP photo.');
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', 'The file could not be read as an image.');
  }
  if ((meta.pages ?? 1) > 1) throw new AppError(422, 'ANIMATED_IMAGE', 'Animated images are not supported.');
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  if (Math.min(w, h) < MIN_EDGE) throw new AppError(422, 'IMAGE_TOO_SMALL', `Photos must be at least ${MIN_EDGE} pixels on the short edge.`);
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 85, progressive: true, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', 'The file could not be read as an image.');
  }
}
