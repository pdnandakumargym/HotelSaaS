# Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **PostgreSQL + Prisma, modular monolith** instead of the MongoDB Atlas and microservices shown in the feasibility doc and deck | The master prompt specifies PostgreSQL, Prisma and a modular monolith. Module boundaries mirror the diagram so services can be extracted later. |
| 2 | **Prisma 7 with `@prisma/adapter-pg`** | Current stable Prisma. Uses the `pg` driver and no native query engine binary. `prisma.config.ts` holds the datasource URL. |
| 3 | **UUIDv7 keys, `timestamptz`, explicit property time zone** | Index locality, UTC storage, correct date handling for inventory and rates. |
| 4 | **CHECK constraints and triggers in hand-written migrations** | Defense in depth for data rules Prisma's schema language cannot express. |
| 5 | **Server-side sessions in HttpOnly cookies** (not JWTs in browser storage) | Instantly revocable sessions and "log out other devices". The token is unreadable to JavaScript, so XSS cannot steal it. |
| 6 | **No live data in the UI until it exists** | The mockups show sample numbers and "Synced" channels. This build shows an em dash, empty states and "Planned · Milestone N" instead. |
| 7 | **No Google/Apple sign-in in Phase 1** | Shown in the login mockup but not in scope. |
| 8 | **No OTA brand logos** | The product connects through Zodomus. OTA availability depends on certification and partner approval, so the UI does not imply OTA connections that do not exist. |
| 9 | **Billing = plan and limit model only (Milestone 3)** | No payment gateway in Phase 1. |
| 10 | **Working product name "StaySync"** | Taken from the mockups. Configurable via `APP_NAME`. |
| 11 | **Admin portal behind platform role + mandatory TOTP** | Enforced by the API (`requirePlatformPermission` also checks an enrolled, verified second factor), not only by the Angular guard. |
| 12 | **Synchronizer CSRF token bound to the session** | Stronger than plain double-submit. Anonymous endpoints rely on the Origin allowlist and JSON-only bodies. |
| 13 | **Account lockout in the database + per-IP and per-account rate limits** | The DB lockout cannot be bypassed by rotating IPs. It is capped (default 15 min) and expires on its own, so attackers cannot lock users out permanently. Per-account limits apply to unknown emails too, so they reveal nothing. |
| 14 | **No account enumeration** | Register, forgot-password and resend-verification always return 202. Login returns one generic 401. Account state (unverified, disabled) is only revealed after a correct password. |
| 15 | **Password reset also needs the second factor when 2FA is on** | A compromised mailbox alone cannot take over an account. |
| 16 | **RLS via transaction-local `app.org_id` + least-privilege role** | Defense in depth with Prisma's connection pool: the setting cannot leak to the next request because it is `set_config(..., true)` inside a transaction. |
| 17 | **Platform roles get no tenant data** | Matches the requirement that admins must not automatically see guest data. Time-boxed, audited, owner-approved support access was added in Milestone 3 (decision 21). |
| 18 | **Own RFC 6238 TOTP implementation (about 80 lines) instead of a library** | Verified against the RFC test vectors, with replay protection built in. One dependency fewer. |
| 19 | **Email change with re-verification** (Milestone 3) | Requires recent authentication; the new address must click a one-time link; the old address is notified before and after. If the new address is taken, the owner of that address gets a notice instead, so the API reveals nothing. |
| 20 | **Plan limits enforced in the API, inside the same transaction as the insert** | The UI only hints. Pending invitations count toward the user limit so it cannot be exceeded by inviting many people at once. |
| 21 | **Support access = owner-approved, time-boxed, read-only grant** | Platform staff request with a reason and duration (15 min to 8 h); an owner approves (with step-up), can revoke at any time, and every read is audited as `support.data_accessed`. Platform permissions alone never open tenant data. |
| 22 | **Non-members get 404 for another organization's resources** | Avoids confirming that an organization or property exists. |
| 23 | **Composite foreign keys for tenant safety** | `room_types (organization_id, property_id)` → properties and `rooms (property_id, room_type_id)` → room_types, so a room can never point at another property's room type even if application code is wrong. |
| 24 | **Delete only when unused** | A property with room types, or a room type with rooms, returns 409 instead of cascading. Prevents accidental loss of inventory structure later tied to channel mappings. |
| 25 | **Setup script chooses a free PostgreSQL port** | Windows (Hyper-V/WSL) reserves port ranges; binding 5432 can fail with "access forbidden". The script checks reserved ranges and listeners and updates both `.env` files. |
| 26 | **Read-only Zodomus client with an allowlist of four GET operations** (Milestone 4) | Only calls documented on the public developer page. No request shapes are guessed; write operations do not exist in the code until the authenticated reference is available. |
| 27 | **One platform-wide Zodomus account in the server environment** | Credentials never reach the database, the browser, logs or audit metadata. The admin UI shows only whether they are set and whether Zodomus accepted them. |
| 28 | **Call log = metadata only** (operation, path, status, outcome, duration, attempts, request id) | Enough for API health and support; bodies could contain guest or payment data, so they are never stored. Logs are append-only for the app role. |
| 29 | **Reference data is sanitized and cached** | Keys that look like credentials or card data are dropped, size is capped. Owners see the cached channel list without triggering provider calls. |
| 30 | **Owners never see a "connected" channel in Milestone 4** | No mapping exists yet, so every property shows "Not connected" and the plan shows 0 channels in use. |
| 31 | **Tests replace the network for Zodomus** | The test harness injects a scripted `fetch`; with no script it refuses all network access. Tests cannot reach Zodomus or touch real inventory. |
| 32 | **Normalize confirmed Zodomus shapes; record the status envelope** | Reference data is reduced to `{id, name}` / `{code, name}` and a minimal account summary (no contact details, no webhook key). `status.returnCode`/`returnMessage` are logged per call and any code other than 200 inside an HTTP 2xx reply is a `PROVIDER_ERROR` (confirmed success code). |
| 33 | **Write calls only from the authenticated spec, allowlisted** (Milestone 5) | property-activation/check/cancellation, rooms-activation, availability, rates, rates-derived, room-rates. Card data (`/reservations-cc`) is not in the allowlist. |
| 34 | **Production writes need `ZODOMUS_ALLOW_PRODUCTION_WRITES=true`** | Development, tests and misconfiguration can never change real Booking.com inventory. Sandbox writes are allowed when Zodomus is enabled. |
| 35 | **Outbox + worker instead of calling Zodomus inside requests** | Calendar edits commit with their sync job in one transaction; the worker re-reads current data, compresses equal days into ranges, retries transient errors (8 attempts, backoff to 1 h) and fails fast on validation errors. Pending jobs for the same target are merged. |
| 36 | **Only priced dates are sent as rates** | A date without a price is skipped rather than sent as 0, so Booking.com never receives an accidental free night. |
| 37 | **Availability capped at rooms in service** | Owners can lower availability or stop-sell, never sell rooms that do not exist. |
| 38 | **One StaySync account per channel property** | Unique `(provider, environment, channelId, channelPropertyId)` prevents two tenants from controlling the same Booking.com property. |
| 39 | **Booking.com price models 1 and 2 only** | Booking supports only these; model 2 (derived) also sends `rates-derived` with the rate plan's single-guest discount. The model must match the Extranet setting. |
| 40 | **Poll the reservation queue instead of the webhook** (Milestone 6) | Works without a public HTTPS endpoint (local and Windows setups) and counts for certification ("reservations-queue or webhook"). The webhook can be added with deployment. |
| 41 | **Queue status codes are authoritative; latest entry per booking wins** | Codes 1/2/3 are documented; the reservation's own status format is not, and Zodomus test mode returns fixed reservation data. Only the last queue entry of a booking is processed, so an old "modified" entry can never undo a cancellation. |
| 42 | **Never guess reservation dates** | Only values starting with a real `YYYY-MM-DD` are used. Anything else stores the booking with "needs review", opens a discrepancy and deducts nothing. |
| 43 | **Guest data encrypted at rest, minimal, never logged** | Only the documented customer/room fields are kept, encrypted (AES-256-GCM, per-booking associated data). An encrypted, sanitized copy of the provider payload is kept because a reservation can be retrieved only once. Logs, audit metadata and discrepancy messages carry booking numbers, never names or contact details. |
| 44 | **Bookings reduce the allotment** | Sellable = max(0, min(rooms to sell, rooms in service) − booked). Treating "rooms to sell" as the total allotment for the date is the conservative choice: it can under-sell, never over-sell. |
| 45 | **Discrepancies are deduplicated and close themselves** | One open item per problem (partial unique index on the dedupe key) with an occurrence count; StaySync resolves overbookings, delivery failures, retrieval failures and incomplete bookings when it sees the problem is gone. People can resolve, ignore or reopen with a note (audited). |
| 46 | **Test bookings only in the sandbox** | `reservations-createtest` is refused unless both the platform and the connection use the Zodomus sandbox. |
| 47 | **Photos are re-encoded, never stored as uploaded** | The real type is read from the file's first bytes; `sharp` decodes and re-encodes to JPEG, which drops EXIF/GPS and anything hidden in the file. Random storage keys, no user file names on disk. |
| 48 | **Photos are private by default; channels get signed, expiring links** | Files are served to organization members only. A channel downloads through `/media/photos/{id}.jpg?exp&sig` (HMAC, 7 days). Without `PUBLIC_MEDIA_BASE_URL` no link is produced. |
| 49 | **No photo push until Zodomus confirms the call** | `POST /property` has no documented target-property field; guessing could create a duplicate Booking.com property. |
| 50 | **Caddy as the HTTPS edge** (Milestone 7) | Automatic certificates and renewal, HTTP/3, one small container that also serves the Angular build; nginx example kept for non-Docker setups. |
| 51 | **Separate worker process, same image** | API and background loops scale and restart independently; heartbeats make a stopped worker visible. Several workers are safe (SKIP LOCKED). |
| 52 | **Reports from stored bookings only** | Fast, no provider quota, works for any channel; rooms in service are today's (no history kept), stated on the page. |
| 53 | **Promotions: read and switch only** | List/activate/deactivate are fully specified by Zodomus; creation values are not, so promotions are created in the extranet. |
| 54 | **Guest-data retention is opt-in** | Guest-register rules differ by country; default keeps data, `GUEST_DATA_RETENTION_DAYS` erases guest details after check-out (booking facts stay for reports). |
| 55 | **Beds24 as a second provider, routed per connection** | `channel_connections.provider` already existed; a `ProviderRegistry` sends each connection's calls to its adapter, so Zodomus code paths are unchanged (all earlier tests pass unmodified, except one constructor call in a test). |
| 56 | **Beds24 writes need two explicit settings** | Beds24 has no sandbox. `BEDS24_ALLOW_WRITES` opts in, and `BEDS24_CALENDAR_TO_INCLUSIVE` records the date-range rule that the reference does not document. It is confirmed read-only by `beds24:check`, never guessed. |
| 57 | **Beds24 restrictions only from price1** | Beds24 keeps min/max stay and arrival/departure rules per room, not per price. Only the rate plan mapped to price1 sends them, so two rate plans cannot overwrite each other. A closed rate plan removes its price for the date. |
| 58 | **Beds24 bookings by modification time** | Beds24 has no queue. StaySync lists bookings changed since the last successful poll (10-minute overlap), skips changes it already stored, and reuses the fetched bookings to save credits. |

## Zodomus facts (public developer page, checked 13 Oct 2026)

- Base URL `https://api.zodomus.com`, HTTP Basic auth with API user/password from the Zodomus backoffice, JSON, TLS 1.2+.
- Free, unlimited sandbox. Production requires Zodomus certification and OTA-side association.
- Full request/response schemas are only in the authenticated backoffice. Operations beyond the
  four read-only account calls stay **blocked pending the authenticated reference**. Mandatory
  fields, IDs and date formats will not be guessed.
- The public Python example POSTs `/channels` while the endpoint list says `GET /channels`. To be verified against the authenticated reference.
