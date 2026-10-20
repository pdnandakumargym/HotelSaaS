# Security review and threat model (Milestone 7, 20 Oct 2026)

Scope: the StaySync API, worker, web app, PostgreSQL, the Zodomus integration and the production deployment in
[deployment.md](deployment.md). Method: assets → entry points → STRIDE threats → controls (with the test or code that
proves them) → residual risks. Reviewed against OWASP ASVS 4 (L2 where practical) and OWASP Top 10 2021.

## Assets

| Asset | Where | Protection |
|---|---|---|
| Guest personal data (names, email, phone, address, remarks) | `reservations.guest_enc` | AES-256-GCM per booking, associated data binds it to org + connection + booking number; decrypted only for `booking.guest_pii.read`; viewing audited |
| Card data | — | **Never requested** (`/reservations-cc` not in the client allowlist, test asserts it), never stored |
| Passwords | `users.password_hash` | Argon2id (19 MiB+ in production) |
| 2FA secrets, recovery codes | `users.totp_secret_enc`, `recovery_codes` | AES-256-GCM; recovery codes HMAC-hashed |
| Sessions, CSRF tokens | cookies + `sessions` | random 256-bit tokens, only SHA-256 stored; HttpOnly, Secure, SameSite; idle/absolute expiry; server-side revocation |
| Zodomus credentials | server environment only | never in DB, logs, audit, browser or API responses (tests assert) |
| Beds24 refresh token / access token | server environment / process memory only | never stored, logged, recorded or returned (tests assert); card fields `stripeToken`/`pcibookingToken` dropped |
| Channel inventory (real Booking.com availability/rates) | Zodomus production, Beds24 (always live) | writes refused unless `ZODOMUS_ALLOW_PRODUCTION_WRITES=true` / `BEDS24_ALLOW_WRITES=true` plus a confirmed `BEDS24_CALENDAR_TO_INCLUSIVE`; tests cannot reach the network |
| Photos | `storage/photos` volume | re-encoded, random names, served to members or by signed expiring links |
| Encryption key | `DATA_ENCRYPTION_KEY` env | per-purpose sub-keys via HKDF; not in backups |

## Entry points

Public: sign-up, sign-in, 2FA, password reset, email verification, invitations, health, signed photo links.
Authenticated: owner API (tenant-scoped), admin API (platform role + 2FA). Outbound: Zodomus (HTTPS, Basic auth), Beds24 (HTTPS, token header), SMTP.
No inbound webhooks (polling only), no file serving from user paths, no server-side fetching of user-supplied URLs.

## STRIDE

| Threat | Example | Controls | Evidence |
|---|---|---|---|
| **Spoofing** | credential stuffing, stolen session | Argon2id, lockout with backoff, per-IP and per-account limits, no account enumeration, TOTP 2FA (mandatory for platform admins; `OWNER_2FA_POLICY=required` in production), step-up for sensitive actions, session rotation | `auth.test.ts` |
| | forged Zodomus responses | TLS only (`https://` enforced), no redirects followed, response size cap, strict parsing; unknown shapes rejected, never guessed | `zodomus-client.test.ts`, `zodomus-reservations.test.ts` |
| **Tampering** | CSRF on state changes | CSRF token header + origin check on unsafe methods; JSON-only bodies | `auth.test.ts` |
| | cross-tenant writes | tenant id from the authorised membership, PostgreSQL RLS (FORCE) on every tenant table under a non-owner role, composite tenant foreign keys | `tenancy.test.ts`, `database.test.ts`, per-module isolation tests |
| | malicious uploads (polyglot, SVG/script, decompression bomb, GPS leak) | real type from magic bytes; only JPEG/PNG/WebP; decode with pixel limit (50 MP); re-encode to JPEG (drops metadata/payloads); 10 MB cap; per-user upload rate limit | `photos.test.ts` |
| | CSV/formula injection in exports | text cells quoted and formula prefixes neutralised | `reports.test.ts` |
| **Repudiation** | "who changed availability / viewed guest data?" | append-only audit log (DB trigger) for auth, admin, support access, guest-data views, mapping, promotions, photos, discrepancy decisions, data purges | `auth.test.ts`, `reservations.test.ts` |
| **Information disclosure** | guest PII to support staff | platform roles get no tenant data; support needs an owner-approved, time-boxed grant and still sees booking facts only, never guest data; every read audited | `organization-admin.test.ts`, `reservations.test.ts` |
| | PII in logs | logger redaction; provider bodies never logged; discrepancy messages and audit metadata carry booking numbers only | `reservations.test.ts` (log scan), `logger.test.ts` |
| | object enumeration | non-members get 404; UUIDv7 ids; signed photo links (HMAC-SHA256, 7-day expiry, constant-time compare) | `photos.test.ts` |
| | secrets in admin UI | config summary shows booleans/hosts only | `admin-system.test.ts` |
| | backups | DB dumps contain only encrypted guest data; key kept separately | deployment.md §4 |
| **Denial of service** | request floods | global per-IP limit (300/min), endpoint limits on auth, body size limits, statement timeout 15 s, provider timeouts | `app.test.ts` |
| | provider outage | outbox with retries/backoff, poller isolates failing connections, discrepancies raised instead of crashing | `channel-sync.test.ts`, `reservations.test.ts` |
| **Elevation of privilege** | staff changing rates, read-only member fetching bookings | permission checks per route (`requireOrgPermission`), role matrix in `rbac/permissions.ts` | `channel-sync.test.ts`, `reservations.test.ts`, `promotions.test.ts`, `permissions.test.ts` |
| | container breakout impact | API/worker run as non-root `node`, no published DB port, DB on an internal network, least-privilege DB role (no BYPASSRLS, no DDL) | `infra/docker/api.Dockerfile`, `docker-compose.prod.yml` |

## OWASP Top 10 (2021) mapping

A01 access control → RLS + permission middleware + 404 for non-members. A02 crypto → Argon2id, AES-256-GCM, HKDF, TLS (Caddy, HSTS).
A03 injection → Prisma parameterised queries; raw SQL only as tagged templates; Zod validation of every body and query.
A04 insecure design → outbox, production-write guard, no card data, data minimisation. A05 misconfiguration → env validated at
start (refuses insecure production settings: http URLs, non-secure cookies, log mail, sandbox+production mix); strict CSP/headers.
A06 vulnerable components → `npm audit --omit=dev --audit-level=high` in CI (0 findings on 20 Oct 2026 after upgrading Prisma to 7.10.1).
A07 auth failures → see Spoofing. A08 integrity → lockfile + `npm ci`, migrations reviewed and drift-checked in CI.
A09 logging → audit log + JSON logs with request ids, admin health page. A10 SSRF → no user-controlled outbound URLs.

## Findings fixed during this review

1. Photo uploads had no per-user rate limit → added (60 per 10 minutes).
2. No retention control for guest data → `GUEST_DATA_RETENTION_DAYS` erases guest details after check-out (audited).
3. Prisma 7.10.0 pulled two high-severity advisories through its CLI dependencies → upgraded to 7.10.1.
4. The example nginx config limited bodies to 1 MB (photo uploads would fail) → 12 MB.
5. CI drift check used `migrate diff --from-migrations`, which cannot apply the RLS migration in a shadow database → replaced by
   `scripts/check-drift.sh` (migrated DB vs schema DB, with an explicit list of hand-written objects).
6. A failure of one connection could stop the background reservation poll for all → isolated per connection.

## Residual risks and recommendations

| Risk | Recommendation |
|---|---|
| Rate-limit counters are per process (in memory) | fine for one API container; use a shared store (Redis) before running several API instances |
| `DATA_ENCRYPTION_KEY` rotation needs a re-encryption job | not built; rotate only with a planned job (decrypt with old key, encrypt with new) |
| Single server: hardware loss means downtime | off-site backups (daily), tested restore; managed PostgreSQL later |
| Zodomus test mode returns fixed data | production behaviour (dates, ids) is confirmed only after go-live; unknown values are stored for review, never guessed |
| Photo push to Booking.com not built | waiting for Zodomus to document how to update an existing property |
| Email deliverability (SPF/DKIM/DMARC) | configure DNS records for the sending domain |
| Owner device compromise | 2FA required; sessions can be revoked from Profile & Security |

## Pre-go-live checklist

- [ ] `infra/.env.production` filled, `chmod 600`, not in Git; `DATA_ENCRYPTION_KEY` stored offline
- [ ] DNS points to the server; `https://<DOMAIN>` shows a valid certificate; `http://` redirects
- [ ] Firewall: only 22 (restricted), 80, 443 open; SSH keys only
- [ ] Admin → System Health: all checks green, one worker live, no pending migrations
- [ ] Platform admin and owner accounts use 2FA; recovery codes stored safely
- [ ] SMTP works (password reset email arrives); SPF/DKIM set
- [ ] Off-site backup copy configured and one restore tested
- [ ] Uptime monitor on `/api/v1/health/ready`
- [ ] Zodomus production keys set; Test connection OK; mapping complete; real prices set; then `ZODOMUS_ALLOW_PRODUCTION_WRITES=true`
- [ ] Decide `GUEST_DATA_RETENTION_DAYS` according to local guest-register rules
