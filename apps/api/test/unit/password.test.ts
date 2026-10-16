import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher, passwordProblems } from '../../src/modules/auth/password.js';

describe('password policy', () => {
  it('accepts long passphrases without composition rules', () => {
    expect(passwordProblems('correct horse battery staple')).toEqual([]);
  });
  it.each([
    ['short1!', /12 characters/],
    ['password1234', /too common/],
    ['aaaaaaaaaaaaaaaa', /repeat/],
    ['                ', /blank/],
  ])('rejects %j', (pw, msg) => {
    expect(passwordProblems(pw).join(' ')).toMatch(msg);
  });
  it('rejects passwords containing the email name', () => {
    expect(passwordProblems('rajesh-loves-hotels', { email: 'rajesh@example.test' }).join(' ')).toMatch(/email/);
  });
});

describe('Argon2id hasher', () => {
  const hasher = new Argon2PasswordHasher({ memoryCost: 1024, timeCost: 1 });

  it('hashes with argon2id and a per-hash salt', async () => {
    const a = await hasher.hash('same password value');
    const b = await hasher.hash('same password value');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=1024,p=1,t=1\$/);
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, 'same password value')).toBe(true);
    expect(await hasher.verify(a, 'different')).toBe(false);
  });

  it('flags hashes made with weaker parameters for rehash', async () => {
    const strong = new Argon2PasswordHasher({ memoryCost: 4096, timeCost: 2 });
    expect(strong.needsRehash(await hasher.hash('x'))).toBe(true);
  });

  it('returns false (does not throw) for malformed hashes', async () => {
    expect(await hasher.verify('not-a-hash', 'x')).toBe(false);
  });
});
