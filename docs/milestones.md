# Milestones

| # | Scope | Status |
|---|---|---|
| 1 | Repository, Angular shell, Express API, PostgreSQL + Prisma, env validation, health checks, Docker Compose, CI | **Done** (see below) |
| 2 | Auth, sessions, CSRF, 2FA, lockout, RBAC, tenant isolation + RLS, audit events | **Done** (see below) |
| 3 | Organization/property/room CRUD, admin portal, plans and limits | **Done** (see below) |
| 4 | Zodomus adapter, credential status, read-only calls, Test Connection, API health, sanitized logs | **Done**, read-only calls confirmed against the Zodomus sandbox |
| 5 | Mapping, room-rates, availability, controlled sandbox writes | **Done** (Booking.com via Zodomus; tested against a fake and a local stub, see below) |
| 6 | Reservations queue, test reservations, sync jobs, discrepancy center | **Done** (tested against a fake and a local stub; run the sandbox steps below) |
| 7 | Full test suite, docs, threat review, deployment readiness | **Done** (see below) |
| 8 | Beds24 as a second channel manager (availability, prices, restrictions, bookings) | **Built and tested against a fake Beds24 API**; live check with your Beds24 account: [beds24-api.md](beds24-api.md) |

## Milestone 1 results

Verified in a Linux build environment (Node 24.21.0, PostgreSQL 16) on 13 Oct 2026:

| Check | Result |
|---|---|
| `apps/api` lint (ESLint, type-aware) | pass |
| `apps/api` typecheck (`tsc --noEmit`, strict) | pass |
| API unit tests | 51 passed |
| API integration tests (real PostgreSQL) | 17 passed |
| `apps/api` production build, started with `NODE_ENV=production` | pass; `/health/ready` returned `ready` |
| Migrations applied to an empty database; schema vs migrations drift | applied; no drift |
| Seed script | pass (idempotent) |
| `apps/web` lint (angular-eslint, incl. template accessibility rules) | pass |
| `apps/web` typecheck + strict templates | pass |
| Angular unit tests | 20 passed |
| Angular production build | pass, about 81 kB initial transfer |
| Browser check (desktop 1440 px and mobile 390 px) | dashboard, admin overview, login and planned pages render; live API/DB status shown |

Not verified on the target Windows machine yet: `scripts/setup-windows.ps1`, Docker Desktop and the
`postgres:17-alpine` container. Run the script, then `npm run check`.

## Milestone 7 results

Verified in the Linux build environment on 20 Oct 2026:

| Check | Result |
|---|---|
| API lint, strict typecheck, production build | pass |
| API tests (adds reports: occupancy/revenue/ADR/RevPAR by night, room type and channel, partial stays, other currencies, test bookings, CSV with formula neutralisation; promotions list/activate/deactivate with documented query parameters, roles, inactive connection; system health without secrets; worker heartbeats; guest-data retention purge; photo upload limits) | 347 passed |
| Web lint, typecheck, unit tests (adds Reports, Promotions, photo gallery; no planned placeholder pages left) | pass, 62 tests |
| Web production build | pass |
| End-to-end smoke (Playwright, desktop 1440 px and mobile Pixel 7): login errors, not found, every owner module opens with no server errors or page errors | 6 passed |
| Production runtime simulation: production-only dependencies installed as in the Docker image; API (`NODE_ENV=production`) ready, worker started, `sharp`/`argon2` native modules load | pass |
| `docker compose -f infra/docker-compose.prod.yml config` | valid |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities (after Prisma 7.10.1) |
| Drift check (`scripts/check-drift.sh`) incl. a negative test | no drift; detects a missing table |

Not verified here: building the Docker images (Docker Hub is blocked in the build environment; CI builds them and validates the
Caddyfile) and a real server deployment.

Delivered:

- **Reports**: occupancy, room nights, revenue, ADR, RevPAR by night (chart + table), room type and channel; bookings and
  cancellations; period presets; CSV export.
- **Discounts & Promotions**: Booking.com promotions with their results (bookings, room nights, revenue); activate/deactivate.
  Creating promotions stays in the extranet (Zodomus does not document the accepted values).
- **Admin System Health & Config**: checks, database and migrations, worker heartbeats, queue, polling, usage, settings in effect.
- **Separate worker process** (`node dist/worker.js`) with heartbeats; the API can run the loops itself for local use.
- **Guest-data retention** (`GUEST_DATA_RETENTION_DAYS`), photo upload rate limit.
- **Deployment**: API/worker/migration image, web image with Caddy (automatic HTTPS, security headers), production compose
  (internal DB network, non-root containers, nightly backups), production env template, [deployment guide](deployment.md),
  CI image builds, audit and drift checks.
- **Security review**: [threat model, findings and checklist](security.md).

## Known limitations (Milestone 7)

- Docker images were not built in this environment (CI builds them). First real deployment should follow docs/deployment.md step by step.
- Rate limits are per process; one API container is assumed (see security.md).
- Encryption-key rotation needs a planned re-encryption job (not built).
- Photo push and promotion creation for Booking.com wait for Zodomus documentation.
- Live Booking.com sync needs Zodomus certification and production keys.

## Photos (added after Milestone 6, 19 Oct 2026)

- Property and room-type photos on **Photos & Amenities**: upload (JPEG, PNG, WebP, up to 10 MB, at least 320 px), caption, main photo,
  order, delete. Files are checked by their real content, decoded and re-encoded to JPEG (max 2560 px) with `sharp`, which removes
  metadata such as the camera's GPS position; stored under random names in `PHOTO_STORAGE_DIR` (default `apps/api/storage/photos`,
  not in Git); served only to signed-in members of the organization, or through signed links that expire after 7 days
  (`/api/v1/media/photos/…`, needs `PUBLIC_MEDIA_BASE_URL`) for channels to download.
- **Not sent to Booking.com yet.** Zodomus's content call `POST /property` (`multimediaDescriptions: [{url, tag}]`) has no documented
  field for the existing property, and the signed-in documentation has no further detail, so a call could create a new Booking.com
  property. Waiting for Zodomus support to confirm how to update an existing property's photos.
- Tests: 6 API integration tests (re-encoding, metadata removal, scaling, invalid/tiny/oversized/duplicate files, roles, tenant
  isolation, signed links) and 3 web tests.

## Milestone 6 results

Reservation schemas were read from the authenticated `swagger.json` on 19 Oct 2026 (see [zodomus-api.md](zodomus-api.md)).
Verified in the Linux build environment on 19 Oct 2026:

| Check | Result |
|---|---|
| API lint, strict typecheck, production build | pass |
| API tests (adds reservation parsing incl. dates with/without time, unrecognised dates, amounts to minor units, rooms/prices as object or array, card-like keys dropped; queue polling, one retrieval per change, summary import once, latest queue entry wins, concurrent polls; guest data encrypted and absent from logs, rows and audit; availability deducted and sent (exclusive `dateTo`); modification releases old nights; cancellation restores; unmapped room, unrecognised dates, overbooking (auto-resolved), retrieval failure (auto-resolved), unknown modification, repeated queue failures; sandbox-only test bookings; guest names hidden from read-only members; support sees booking facts only under an approved grant (audited); tenant isolation; failed sync job → discrepancy → retry → auto-resolved; resolve/ignore/reopen audited; room type with bookings cannot be deleted) | 326 passed |
| Migrations on an empty database; drift check (columns, indexes, keys, enums of migrated vs schema-generated databases) | applied; no drift (only the two hand-written partial indexes differ, as intended) |
| Web lint, typecheck, unit tests (adds Bookings and Discrepancy Center) | pass, 57 tests |
| Web production build | pass |
| Browser walkthrough against a local HTTPS Zodomus stub (fake data): connect and map → create two test bookings → detail view with guest data → modify both onto the same nights (overbooking opened, calendar shows "2 booked") → cancel one (overbooking resolved automatically) → Synchronization Status with delivered availability updates | pass |

Features: Bookings (list with upcoming / past / all, status, needs-review and booking-number filters; detail with stay, rooms,
mapping, inventory effect and guest details for permitted roles, audited); fetch now; import earlier bookings; sandbox test
bookings; availability = min(rooms to sell, rooms in service) − rooms booked; Synchronization Status (per connection: queued,
delivered and failed updates, last delivery, last booking fetch, retry failed updates); Discrepancy Center (overbooking, unmapped
room, incomplete booking, booking not retrieved, unknown booking changed, update not delivered, bookings not fetched; one open item
per problem with an occurrence count, automatic resolution, resolve / ignore / reopen with notes); admin **Sync Jobs**
(platform-wide counts only); admin support view of booking facts under an owner-approved grant (never guest data).

## Known limitations (Milestone 6)

- Reservation calls were checked against the real Zodomus sandbox on 19 Oct 2026 with `npm run zodomus:reservations` (createtest,
  queue, summary, reservation); the shapes found are in [zodomus-api.md](zodomus-api.md) and are covered by tests. Test mode returns
  one fixed booking for every queue entry, so sandbox bookings all look alike. Unrecognised values are never guessed: the booking is
  stored, flagged "needs review" and not deducted.
- Past stays (from the summary's fixed samples) are stored without opening discrepancies.
- The swagger does not document the format of the queue `date` field or of reservation status words; StaySync relies on the
  documented queue codes 1/2/3 and stores the other values as text.
- Bookings are fetched by polling (every minute by default). The optional Zodomus webhook is not implemented (it needs a public
  HTTPS endpoint; planned with deployment in Milestone 7).
- `GET /reservations-cc` (card data) is never called, so certification step 12 remains an open point with Zodomus support.
- Guest details are encrypted with a key derived from `DATA_ENCRYPTION_KEY`; rotating that key needs a re-encryption job (Milestone 7).
- A reservation room that is not mapped is not deducted. After mapping the room, adjust availability for those nights by hand
  (or wait for the booking's next modification).

## Milestone 5 results

The authenticated Zodomus API reference (OpenAPI spec + integration guide) was read on 16 Oct 2026 in the owner's signed-in
backoffice session; the facts used are in [zodomus-api.md](zodomus-api.md). Verified in the Linux build environment on 16 Oct 2026:

| Check | Result |
|---|---|
| API lint, strict typecheck, production build | pass |
| API tests (adds rate plans, calendar bulk updates incl. weekdays/partial fields/caps/past dates/roles/tenant isolation, Booking.com activation, room-rates normalisation, mapping validation, rooms-activation payload, ACTIVE + one-year sync, exact availability and rates payloads with exclusive `dateTo`, range compression, merge of pending edits, resync on room status change, retry with backoff, fail-fast on 4xx and on Zodomus error codes in HTTP 200, production-write guard, no card-data operation, no credentials or bodies in logs, disconnect, derived pricing) | 291 passed |
| Migrations on an empty database; drift check (columns, indexes, keys, enums) | applied; no drift |
| Web lint, typecheck, unit tests (adds mapping page and connected-channel display) | pass, 50 tests |
| Web production build | pass, about 99 kB initial transfer |
| Browser walkthrough against a local HTTPS Zodomus stub: create rate plans → set prices and availability → connect Booking.com (property-activation, room-rates) → map rooms/rates → property-check, rooms-activation, property-check → background worker sent availability (3 ranges), rates and rates-derived | pass; request bodies matched the documented formats |

Features: rate plans (meal plan, single-guest discount for derived pricing); inventory & rates calendar (14-day grid, bulk edit by date range,
weekdays, room types and rate plans: rooms to sell, stop-sell, price, single price, minimum stay, closed); Booking.com connection wizard (price
models 1 Maximum/single and 2 Derived, plan channel limit, one StaySync account per Booking.com property); room and rate mapping with
validation; automatic sync outbox (one year on connect, then only changed ranges; merged edits; retries; per-connection job history);
disconnect via property-cancellation.

## Known limitations (Milestone 5)

- **Not yet run against the real Zodomus sandbox** for the write calls (the build environment cannot reach it). Run the steps in the
  README on your PC; Zodomus test mode returns fixed responses, so success there proves the request format, not real Booking.com data.
- (Resolved in Milestone 6: reservations are deducted from availability.)
- Restrictions sent: closed, minimum/maximum stay, closed on arrival/departure. Advance-booking limits, exact stay and weekday masks
  are not exposed in the UI yet. Price models 3/4 (Expedia/Airbnb) are not supported.
- Zodomus certification step 12 requires `GET /reservations-cc` (card data), which StaySync deliberately does not call in Phase 1.
  Ask Zodomus support whether it can be waived before applying for production.
- The sync worker runs inside the API process (every 5 s). For several API instances it is safe (row locking), but a separate worker
  process is recommended for production (Milestone 7).

## Milestone 4 results

Verified in the Linux build environment (Node 24.21.0, PostgreSQL 16, API as `staysync_app`) on 16 Oct 2026:

| Check | Result |
|---|---|
| API lint, strict typecheck, production build | pass |
| API tests (adds Zodomus client: Basic auth, allowed paths only, retries on 429/5xx, no retry on 401, timeout, network error, invalid JSON, size cap, no credentials in logs or records; payload sanitizer; integration: disabled → 409, untested → rejected → verified states, health window, call log append-only, audit, reference refresh and cache, failed refresh keeps cache, support read-only, owner view never claims a connection, non-member 404) | 261 passed |
| Migrations on an empty database; drift check (column, index, key and enum comparison of migrated vs schema-generated databases) | applied; no drift |
| Web lint, typecheck, unit tests (adds channels page, JSON table incl. HTML-injection check) | pass, 46 tests |
| Web production build | pass, about 98 kB initial transfer |
| Browser walkthrough against a local HTTPS stub of Zodomus (fake data): owner Channels page before/after, admin Test Connection, fetch channel list, health tiles, API logs, mobile 390 px | pass; API log contained no credentials |

Features: `ChannelProvider` port with a `ZodomusAdapter`; read-only client limited to `GET /account`, `/channels`,
`/currencies`, `/price-model`; Test Connection; credential state (missing / not verified / valid / rejected);
connection state (disabled / not configured / not tested / connected / degraded / failing); API health (calls, error
rate, p50/p95 latency, last success and failure over 24 h); metadata-only call log; sanitized reference-data cache;
admin pages Channel Providers, Zodomus Health and API Logs; owner Channel Connections page;
`npm run zodomus:probe` (structure-only diagnostics).

## Known limitations (Milestone 4)

- Confirmed on 16 Oct 2026 on the owner's Windows PC with `npm run zodomus:probe`: all four read-only calls returned
  HTTP 200 (about 0.3 to 1.5 s). Every response has a `status` envelope (`returnCode`, `returnMessage`, `channelLogId`,
  `channelOtherMessages`, `timestamp`) plus `account`, `channels` [{id, channel}], `currencies` [{code, name}] or
  `models` [{id, model}]. These shapes are now normalized before caching; the account's contact details and webhook key are not stored.
- All four calls returned `status.returnCode` 200 / `returnMessage` "OK". StaySync now treats any other return code inside
  an HTTP 2xx reply as a failure (`PROVIDER_ERROR`): no data is cached, it counts in API health, and it is not retried.
- The build environment itself cannot reach `api.zodomus.com`; the automated tests use a scripted fake.
- One platform-wide Zodomus account (credentials in the server environment). Per-organization credentials are not supported.
- Health is computed from real calls only; there is no background heartbeat. Call logs have no retention job yet (Milestone 7).
- Property mapping, rates, availability and reservations remain blocked on the authenticated API reference (Milestone 5).

## Milestone 3 results

Verified in the Linux build environment (Node 24.21.0, PostgreSQL 16, API as `staysync_app`) on 15 Oct 2026:

| Check | Result |
|---|---|
| API lint, strict typecheck, production build | pass |
| API unit + integration tests (adds property/room-type/room CRUD, validation, plan limits, cross-tenant 404s, RBAC per role, delete protection, invitations, member roles and last-owner guard, email change, org suspension, admin org/subscription changes, support-access approve/deny/revoke/expiry and audited reads) | 228 passed |
| Migrations on an empty database; drift check | applied; no drift |
| Web lint, typecheck, unit tests | pass, 41 tests |
| Web production build | pass, about 98 kB initial transfer |
| Browser walkthrough with the real API: register → create property → room type → bulk rooms → set a room out of service → billing → invite a manager who accepts by creating an account → support admin with 2FA requests access → owner approves in settings → admin reads the property list (audited) → admin properties list | pass |

Features: property profile (type, address, time zone, currency, check-in/out, contact, rating, policies, amenities);
room types with occupancy rules; physical rooms (single and bulk, status); amenity catalog; plans FREE / PRO / PREMIUM
with property and user limits enforced by the API (402 `PLAN_LIMIT_REACHED`); billing page (no payment gateway);
invitations (7-day, single-use, link token in URL fragment); member role changes and removal; organization settings
and "require 2FA for all members"; email change with re-verification and notice to the old address; admin customer
detail, suspend/reactivate, plan change (step-up required), properties list, plans; support access requested by staff,
approved by an owner, read-only, time-boxed, revocable, every read audited.

## Known limitations (Milestone 3)

- Property photos are not built (needs object storage); the Photos page says so.
- Channel limits per plan are stored and shown, but nothing counts channels until Milestone 4.
- Support access currently exposes only the property/room list read-only. Guest data does not exist yet; when reservations
  arrive (Milestone 6) the same grant check and audit apply.
- Plan changes are manual (admin portal). No payment gateway, invoices or automatic downgrade in Phase 1.
- Rate-limit counters are still per process (see Milestone 2).

## Milestone 2 results

Verified in the Linux build environment (Node 24.21.0, PostgreSQL 16, API connected as the least-privilege
`staysync_app` role) on 14 Oct 2026:

| Check | Result |
|---|---|
| API lint, strict typecheck, production build | pass |
| API unit tests (config, TOTP RFC vectors, encryption, password policy, Argon2id, RBAC matrix, cookies, HTTP security) | 96 passed |
| API integration tests against PostgreSQL (schema, auth flows, lockout, 2FA, CSRF, sessions, step-up, RBAC, cross-tenant, RLS) | 87 passed |
| Web lint (incl. template accessibility), typecheck, unit tests (guards, login, 2FA challenge, step-up, interceptor) | pass, 31 tests |
| Web production build | pass |
| Browser walkthrough with the real API: register, verify email, sign in, enable 2FA (QR, code, recovery codes), sign out, sign in with 2FA, team page, generic login error, admin first sign-in with forced 2FA enrollment, admin users and audit pages, step-up dialog before password change | pass |
| Logs checked for passwords, session and CSRF tokens | none found |

Security requirements covered: registration and email verification; login and logout; single-use expiring reset
tokens; Argon2id; mandatory TOTP 2FA for platform admins; configurable 2FA for owners (global policy plus per-organization
"require for all members"); recovery codes; step-up authentication; session listing and revocation; per-account
lockout with capped exponential backoff; per-IP and per-account rate limits; generic errors; audit of auth events;
lockout, password-change, 2FA-off and recovery-code-used emails; RBAC enforced by the API; tenant isolation in API
and repository code plus PostgreSQL RLS; least-privilege database role.

## Known limitations (Milestone 2)

- Rate-limit counters are in memory, per API process. Use a shared store (Redis or PostgreSQL) before running several instances.
  The account lockout is in the database, so it already works across instances.
- Not implemented yet: WebAuthn/passkeys, SSO. (Invitations, member management, email change and support access were added in Milestone 3.)
- `MAIL_TRANSPORT=log` (development only) prints email bodies, including one-time links, to the API log. Production refuses it.
- Changing `DATA_ENCRYPTION_KEY` makes enrolled authenticator apps unusable (users would need a reset). Key rotation is not implemented yet.
- `scripts/setup-windows.ps1` and Docker now run on the target Windows machine (PostgreSQL on port 55432 there; the script now picks a free port automatically).

## Known limitations (Milestone 1)

- No authentication or authorization. The admin portal is a preview with no data or actions. Do not expose this build publicly.
- Only `organizations`, `properties` and `audit_events` tables exist.
- The Zodomus integration is not started. The UI shows "Not configured".
- No end-to-end (Playwright) tests yet (Milestone 7).
- In the build environment, Prisma's native schema-engine binary download was blocked by network policy.
  Migrations were generated and applied there with Prisma's official WebAssembly schema engine
  (`@prisma/schema-engine-wasm`, same version), so the SQL is Prisma's own output. On a normal machine
  `prisma migrate deploy` downloads the native engine automatically.

- `npm audit` reports high-severity advisories in `mysql2` and `deepmerge-ts`. Both come in through the
  Prisma 7.10 CLI (a dev dependency). StaySync uses PostgreSQL only, so the MySQL driver code never runs.
  `npm audit fix --force` would downgrade Prisma to 6.x, so don't run it. Re-check when Prisma ships a fix.

## Outstanding partner requirements

- Zodomus sandbox account and API credentials (put them only in `apps/api/.env`).
- Access to the authenticated Zodomus API reference and test property details (needed for Milestone 5).
- Zodomus certification and per-OTA association before any production channel connection.
