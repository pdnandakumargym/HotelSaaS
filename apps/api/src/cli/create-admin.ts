/**
 * Creates (or promotes) a platform administrator.
 *
 *   npm run admin:create -w @staysync/api -- --email you@example.com --name "Your Name" [--role support]
 *
 * A random password is generated and printed ONCE. Two-factor authentication must be
 * set up at first sign-in (it is mandatory for platform roles).
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/env.js';
import { createDatabase } from '../infrastructure/db/prisma.js';
import { withSystem } from '../infrastructure/db/tenant.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { normalizeEmail } from '../modules/auth/auth.service.js';
import { Argon2PasswordHasher } from '../modules/auth/password.js';
import { createLogger } from '../shared/logger.js';
import { randomToken } from '../shared/crypto.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'super' } },
});

if (!values.email || !values.name) {
  process.stderr.write('Usage: npm run admin:create -w @staysync/api -- --email you@example.com --name "Your Name" [--role super|support]\n');
  process.exit(2);
}
const role = values.role === 'support' ? 'PLATFORM_SUPPORT' : 'PLATFORM_SUPER_ADMIN';
const config = loadConfig();
const logger = createLogger({ level: 'warn' });
const db = createDatabase({ connectionString: config.databaseUrl, max: 2 });
const hasher = new Argon2PasswordHasher(config.auth.argon2);
const email = normalizeEmail(values.email);

try {
  const password = `${randomToken(12)}-${randomToken(6)}`;
  const passwordHash = await hasher.hash(password);
  const user = await withSystem(db, async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      return tx.user.update({ where: { id: existing.id }, data: { platformRole: role } });
    }
    return tx.user.create({ data: { email, displayName: values.name!, passwordHash, platformRole: role, emailVerifiedAt: new Date() } });
  });
  await new AuditService(db, logger).record({ action: 'admin.platform_role.granted', actorType: 'system', entityType: 'user', entityId: user.id, metadata: { role, via: 'cli' } });
  if (user.passwordHash === passwordHash) {
    process.stdout.write(`\nCreated ${role} ${email}\nTemporary password (shown once): ${password}\nSign in and set up two-factor authentication, then change this password.\n\n`);
  } else {
    process.stdout.write(`\nGranted ${role} to existing user ${email}. Their password is unchanged. 2FA setup is required at next sign-in.\n\n`);
  }
} finally {
  await db.$disconnect();
}
