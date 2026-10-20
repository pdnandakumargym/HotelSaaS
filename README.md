# StaySync

Multi-tenant SaaS for hotels, homestays, villas, bungalows and resorts to manage
property operations in one place, and later synchronize rates, availability and
reservations to booking channels through the **Zodomus** channel-manager API.

> **Status: all seven milestones complete (StaySync 1.0).** Owner portal: properties, rooms, photos & amenities, inventory &
> rates calendar, rate plans, Booking.com connection & mapping via Zodomus, bookings, synchronization status, discrepancy center,
> promotions, reports, billing, team and security settings. Admin portal: customers, properties, plans, users, audited support
> access, channel providers, Zodomus health, API logs, sync jobs and system health. Production deployment: Docker + Caddy (HTTPS),
> separate worker, nightly backups — see [docs/deployment.md](docs/deployment.md) and the security review in
> [docs/security.md](docs/security.md). Card data is never requested or stored.
> See [docs/milestones.md](docs/milestones.md).

| Layer | Technology |
|---|---|
| Web | Angular 22 (standalone components, signals, zoneless), SCSS |
| API | Node.js 24 LTS, TypeScript 6, Express 5, Zod 4, Pino |
| Database | PostgreSQL 17, Prisma 7 (driver adapter `@prisma/adapter-pg`) |
| Tooling | npm workspaces, Vitest, ESLint, Docker Compose, GitHub Actions |

## Repository layout

```
apps/
  api/            Express API (modules: config, middleware, health, openapi; more per milestone)
    prisma/       schema.prisma, migrations/, seed.ts
    test/         unit/ (no DB) and integration/ (real PostgreSQL)
  web/            Angular app: owner portal (/app) and admin portal (/admin)
infra/
  docker-compose.yml   PostgreSQL + Mailpit for local development
  nginx/               example production reverse-proxy config
scripts/
  setup-windows.ps1    one-shot setup for Windows
docs/                  architecture, decisions, milestones
Architecture/          original design references (images, feasibility doc, deck)
```

## Prerequisites

- **Node.js 24 LTS** (24.15 or newer; 22.22.3+ also works)
- **Docker Desktop** (for PostgreSQL). On Windows it needs WSL 2.
- Git (recommended)

## Quick start on Windows

Open **PowerShell as administrator** (needed only if Node or Docker must be installed),
`cd` to the repository folder and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-windows.ps1
```

The script:

1. Checks Node.js and installs **Node.js LTS** with `winget` if it is missing or too old (asks first).
2. Checks Docker and installs **Docker Desktop** with `winget` if it is missing (asks first).
   After a fresh Docker install, restart or sign out/in, start Docker Desktop once, then run the script again.
3. Creates `infra/.env` (random database password) and `apps/api/.env`. Both are git-ignored.
   It picks a free PostgreSQL port (5432, else 55432, 15432, ...) because Windows sometimes reserves 5432,
   and writes it to both files.
4. Runs `npm install`, starts PostgreSQL and Mailpit, creates the least-privilege `staysync_app` database role,
   applies migrations and seeds clearly-fake demo data (it prints a one-time password for the demo owner
   `owner@demo.staysync.test`).

The script also generates `DATA_ENCRYPTION_KEY` (encrypts 2FA secrets) and the database passwords. If you already
created `apps/api/.env` during Milestone 1, delete it and run the script again so the new settings are added.

**Updating an existing install** (after pulling a new milestone): `npm install`, then `npm run db:deploy`.
The seed (`npm run db:seed`) is optional.

Check what is installed without changing anything: `.\scripts\setup-windows.ps1 -CheckOnly`

Then start both apps:

```powershell
npm run dev
```

| URL | What |
|---|---|
| http://localhost:4200 | Web app (owner portal). `/admin` opens the admin portal (platform admins only). |
| http://localhost:3000/api/v1/health | API liveness |
| http://localhost:3000/api/v1/health/ready | API readiness (checks PostgreSQL) |
| http://localhost:3000/api/docs | Swagger UI (development only) |
| http://localhost:8025 | Mailpit (captured dev email, used from Milestone 2) |

## Zodomus (channel manager)

Put the sandbox credentials from the Zodomus backoffice **only** in `apps/api/.env` (never in code or chat):

```dotenv
ZODOMUS_ENABLED=true
ZODOMUS_ENVIRONMENT=sandbox
ZODOMUS_API_USERNAME=...
ZODOMUS_API_PASSWORD=...
```

Restart the API, then:

- `npm run zodomus:probe` calls the four read-only account endpoints and prints status, timing and the response
  **structure** (key names and types, no values). The output is safe to share.
- In the admin portal, **Channel Providers → Test connection** verifies the credentials; **Zodomus Health** and
  **API Logs** show what happened. Writes (availability, rates) happen only for properties an owner has connected and mapped.

### Connect a property to Booking.com (sandbox)

1. **Rates & Rate Plans**: create at least one rate plan (e.g. "Standard").
2. **Inventory Calendar**: set prices for the coming dates (dates without a price are never sent).
3. **Room & Rate Mapping**: enter a Booking.com property ID (in test mode any number works), choose the pricing model, Connect.
4. Link each Booking.com room to your room type and each rate to a rate plan, then **Save mapping & activate rooms**.
5. One year of availability and rates is sent in the background; see "Recent updates sent to Booking.com".
   Every call also appears in the admin portal under **API Logs**.

### Bookings (Milestone 6)

- Every minute StaySync reads the Zodomus reservation queue of each active connection, retrieves each new, modified or
  cancelled booking once, stores it (guest details encrypted) and subtracts it from availability. The new availability is
  then sent to every connected channel. **Bookings → Fetch new bookings now** does the same on demand.
- On the first fetch, bookings made before the connection are imported once (`reservations-summary`); **Import bookings made
  before connecting** repeats it.
- In the sandbox, **Bookings → Create a test booking** asks Zodomus to create a new, modified or cancelled test booking
  (`reservations-createtest`) and fetches it. Test bookings are labelled as such.
- `npm run zodomus:reservations -- <property id>` (add `--create new` in the sandbox) prints the status envelope, the
  response structure and what StaySync's parser understood (booking number, status, room ids, dates). Guest names and
  contact details are never printed. Share this output if bookings do not appear as expected.
- **Synchronization Status** shows queued, delivered and failed updates per connection and when bookings were last fetched;
  failed updates can be retried. **Discrepancy Center** lists overbookings, unmapped rooms, incomplete bookings and
  undelivered updates; most close automatically when the problem is gone.

### Photos

**Photos & Amenities** stores property and room-type photos (re-encoded, metadata removed) in `apps/api/storage/photos` by default
(`PHOTO_STORAGE_DIR`). They are not sent to Booking.com yet; see [docs/milestones.md](docs/milestones.md).

### Beds24 (optional second channel manager)

A property can also be connected to **Beds24**, which passes availability and prices on to the channels connected in your
Beds24 account (paid Beds24 accounts only). Setup, safety switches and what is synchronised: [docs/beds24-api.md](docs/beds24-api.md).

Real Booking.com properties need Zodomus certification first, then `ZODOMUS_ENVIRONMENT=production` with production API keys and
`ZODOMUS_ALLOW_PRODUCTION_WRITES=true` (see [docs/zodomus-api.md](docs/zodomus-api.md)).

## Accounts and first sign-in

- **Owners** sign up at http://localhost:4200/register. The verification email lands in Mailpit (http://localhost:8025).
- **Platform administrators** cannot sign up. Create one from the command line:

  ```powershell
  npm run admin:create -- --email you@example.com --name "Your Name"
  ```

  It prints a one-time password. At first sign-in you must set up an authenticator app (2FA is mandatory for admins).
- Turn on 2FA for any account under **Profile & Security**. Owners can require 2FA for every member of their organization.

## Manual setup (any OS)

```bash
cp infra/.env.example infra/.env            # set POSTGRES_PASSWORD
cp apps/api/.env.example apps/api/.env      # copy both passwords into the four database URLs,
                                             # set DATA_ENCRYPTION_KEY (see the comment in the file)
npm install
npm run db:up                                # docker compose up -d (creates staysync_app on a new volume)
npm run db:deploy                            # prisma migrate deploy (runs as the owner)
npm run db:seed
npm run dev
```

The Postgres container creates `staysync_test` (used only by integration tests) the
first time its data volume is created. If you created the volume before this file
existed, create it once with:
`docker compose -f infra/docker-compose.yml exec postgres createdb -U staysync staysync_test`

## Everyday commands

| Command | Description |
|---|---|
| `npm run dev` | API (watch mode) + Angular dev server with `/api` proxy |
| `npm run check` | lint, typecheck, all tests, production builds |
| `npm test` | API unit + integration tests, Angular unit tests |
| `npm run db:migrate -- --name <change>` | create a new migration after editing `schema.prisma` |
| `npm run db:deploy` | apply pending migrations |
| `npm run db:seed` | load demo data (refuses to run in production) |
| `npm run admin:create -- --email … --name …` | create or promote a platform administrator |
| `npm run db:down` | stop local services (data volume is kept) |
| `npm run db:studio -w @staysync/api` | browse the database with Prisma Studio |

## Configuration

All API settings are environment variables validated at startup
(`apps/api/src/config/env.ts`). The API refuses to start with an invalid config and
names the variable without echoing its value. See `apps/api/.env.example`.

Important rules enforced at startup:

- `CORS_ORIGINS` must list exact origins. `*` and wildcards are rejected; production requires `https`.
- `TRUST_PROXY` accepts `false`, a hop count, or proxy IPs/CIDRs. `true` (trust everyone) is rejected.
- `DATA_ENCRYPTION_KEY` (32 random bytes, base64) is required. It encrypts TOTP secrets.
- Production requires `https` for `APP_BASE_URL`, Secure cookies, real SMTP and Argon2 memory ≥ 19 MiB.
- `ZODOMUS_*` credentials are server-side only. `ZODOMUS_ENABLED=true` requires both credentials.
  Sandbox Zodomus config is refused when `NODE_ENV=production`, and production Zodomus is refused outside production.

**Never put real secrets in Git, docs, screenshots or seed data.** `.env` files are git-ignored.

## Testing

- **API unit tests** (`apps/api/test/unit`): config validation, CORS allowlist, origin checks,
  proxy/client-IP handling, security headers, body limits, error envelope, correlation IDs,
  log redaction, rate limiting, OpenAPI.
- **API integration tests** (`apps/api/test/integration`) run against the real PostgreSQL database in
  `TEST_DATABASE_URL` as the least-privilege role. They apply pending migrations automatically using
  `TEST_MIGRATION_DATABASE_URL`. They cover:
  - schema rules, the append-only audit log and transaction rollback
  - registration and verification, login, account enumeration, lockout and IP rotation, password reset
  - 2FA (enrollment, challenge, replay, recovery codes, mandatory for admins, organization policy)
  - CSRF, sessions, step-up
  - the RBAC matrix, cross-tenant 404s and row-level security
- **Web unit tests** (`apps/web/src/**/*.spec.ts`): routing, navigation, system-status
  states (healthy / degraded / unreachable), login form validation, HTTP interceptor.

`TEST_DATABASE_URL` must point to a different database from `DATABASE_URL`; the tests refuse to run otherwise.

## Security notes

**Milestone 1:**

- Helmet security headers and a strict CSP on API responses
- explicit CORS allowlist, and 403 for state-changing requests from unknown origins
- request size limits and validated proxy trust
- correlation IDs and log redaction
- append-only audit table

**Milestone 2:**

- Argon2id passwords, and HttpOnly session cookies with server-side revocation
- CSRF tokens and step-up authentication
- TOTP 2FA with recovery codes (mandatory for platform admins)
- account lockout with capped backoff, plus per-IP and per-account rate limits
- no account enumeration
- RBAC enforced in the API
- tenant isolation in code plus PostgreSQL row-level security, under a least-privilege database role
- audit events for all authentication and admin actions

**Milestones 5–7:** guest data encrypted (AES-256-GCM) and audited when viewed, no card data, production writes need an explicit
switch, photos re-encoded and served only to members or by signed links, upload and request rate limits, guest-data retention,
non-root containers, database on an internal network, automatic HTTPS with HSTS. Full threat model, fixed findings, residual
risks and the go-live checklist: [docs/security.md](docs/security.md).

## End-to-end smoke tests

With the app running locally: `E2E_OWNER_EMAIL=... E2E_OWNER_PASSWORD=... npm run e2e` (first time: `npx playwright install chromium`).
Use a test account, never production credentials.

## Documentation

- [docs/architecture.md](docs/architecture.md): architecture, module boundaries, request pipeline, ER diagram
- [docs/decisions.md](docs/decisions.md): decisions and resolved conflicts with the reference documents
- [docs/milestones.md](docs/milestones.md): roadmap, Milestone 1 results and known limitations
