import argon2 from 'argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
  /** Performs a verification against a fixed dummy hash to equalize timing for unknown accounts. */
  burn(password: string): Promise<void>;
}

/** Argon2id, OWASP-recommended baseline parameters (configurable). */
export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly params: { memoryCost: number; timeCost: number }) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: this.params.memoryCost, timeCost: this.params.timeCost, parallelism: 1 });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    return argon2.needsRehash(hash, { memoryCost: this.params.memoryCost, timeCost: this.params.timeCost, parallelism: 1 });
  }

  async burn(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-equalization');
    await this.verify(await this.dummyHash, password);
  }
}

const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', '123456789012', 'qwertyuiopas', 'iloveyou1234', 'welcome12345',
  'administrator', 'letmein12345', 'changeme1234', 'passw0rd1234', 'qwerty123456', '1q2w3e4r5t6y',
  'staysync1234', 'hotel1234567', 'password@123', 'admin1234567',
]);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Length-based policy (NIST SP 800-63B): no composition rules, block common and context-specific passwords. */
export function passwordProblems(password: string, context: { email?: string; displayName?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  if (password.trim().length === 0) problems.push('Password cannot be blank.');
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) problems.push('This password is too common.');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Do not include your email address.');
  return problems;
}
