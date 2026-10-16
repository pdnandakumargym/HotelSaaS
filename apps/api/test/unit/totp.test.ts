import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpAt, verifyTotp } from '../../src/modules/auth/totp.js';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"); RFC values are 8 digits, we use the last 6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORS)('matches the RFC test vector at T=%i', (t, expected) => {
    expect(totpAt(RFC_SECRET, t * 1000)).toBe(expected.slice(-6));
  });

  it('matches RFC 4226 HOTP vectors', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('round-trips base32 and generates 160-bit secrets', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('accepts one step of clock drift but not more', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), { nowMs: now })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 90_000), { nowMs: now })).toBeNull();
  });

  it('rejects codes at or before the last used step (replay protection)', () => {
    const now = 1_700_000_000_000;
    const c = totpAt(RFC_SECRET, now);
    const step = verifyTotp(RFC_SECRET, c, { nowMs: now })!;
    expect(verifyTotp(RFC_SECRET, c, { nowMs: now, lastUsedStep: step })).toBeNull();
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345')).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = otpauthUri('StaySync', 'owner@example.test', 'ABCDEF');
    expect(uri).toMatch(/^otpauth:\/\/totp\/StaySync%3Aowner%40example\.test\?/);
    expect(uri).toContain('secret=ABCDEF');
    expect(uri).toContain('issuer=StaySync');
  });
});
