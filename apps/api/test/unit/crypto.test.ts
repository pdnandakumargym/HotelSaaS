import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptString, deriveKey, encryptString, safeEqualHex, sha256Hex } from '../../src/shared/crypto.js';

const master = randomBytes(32);

describe('secret encryption (AES-256-GCM)', () => {
  const key = deriveKey(master, 'totp-secret-encryption');

  it('round-trips and never contains the plaintext', () => {
    const enc = encryptString(key, 'JBSWY3DPEHPK3PXP', 'totp:user-1');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptString(key, enc, 'totp:user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptString(key, 'x', 'a')).not.toBe(encryptString(key, 'x', 'a'));
  });

  it('detects tampering', () => {
    const enc = encryptString(key, 'secret', 'aad');
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptString(key, parts.join('.'), 'aad')).toThrow();
  });

  it('binds ciphertext to its owner (associated data)', () => {
    const enc = encryptString(key, 'secret', 'totp:user-1');
    expect(() => decryptString(key, enc, 'totp:user-2')).toThrow();
  });

  it('derives independent keys per purpose', () => {
    expect(deriveKey(master, 'a').equals(deriveKey(master, 'b'))).toBe(false);
    expect(deriveKey(master, 'a').equals(deriveKey(master, 'a'))).toBe(true);
  });

  it('compares digests safely', () => {
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('a'))).toBe(true);
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('b'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
  });
});
