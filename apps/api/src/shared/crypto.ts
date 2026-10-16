import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Derives an independent 32-byte sub-key per purpose from the master key (HKDF-SHA256). */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `staysync:${purpose}`, 32));
}

const ENC_VERSION = 'v1';

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). Associated data binds the ciphertext to its owner. */
export function encryptString(key: Buffer, plaintext: string, associatedData: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptString(key: Buffer, payload: string, associatedData: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== ENC_VERSION || !iv || !tag || !ciphertext) throw new Error('unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
