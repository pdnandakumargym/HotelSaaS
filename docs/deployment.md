# Deploying StaySync to production

One Linux server running Docker. Five containers: **web** (Caddy: HTTPS, the Angular app, proxy to the API),
**api**, **worker** (sends availability/rates, fetches bookings), **postgres**, and **backup** (nightly dump).
A one-off **migrate** container applies database migrations on every deploy.

```text
Internet ──443/80──> web (Caddy, automatic TLS) ──/api──> api ──> postgres
                                                   worker ──> postgres
                                 api, worker ──HTTPS──> Zodomus, SMTP
```

Only Caddy publishes ports. PostgreSQL is on an internal network with no route to the internet.

## 1. Server

- Ubuntu 24.04 LTS (or any Linux with Docker Engine 25+ and Compose v2), 2 vCPU, 4 GB RAM, 40 GB SSD is enough to start.
  Any provider works (a VPS, Azure, AWS Lightsail, DigitalOcean, Hetzner).
- Firewall: allow inbound 22 (SSH, preferably only from your IP), 80 and 443. Nothing else.
- Turn on automatic security updates (`unattended-upgrades`), use SSH keys only, disable password login.
- A DNS **A record** (and AAAA if you have IPv6) for your app name, e.g. `app.yourhotel.com`, pointing at the server.

## 2. First installation

```bash
sudo apt install -y docker.io docker-compose-v2 git      # or Docker's own packages
git clone <your repository> staysync && cd staysync       # or copy the project folder
cp infra/.env.production.example infra/.env.production
chmod 600 infra/.env.production
nano infra/.env.production                                # fill in EVERY value (see below)
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production up -d --build
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production ps
```

Values to set in `infra/.env.production`:

| Setting | How |
|---|---|
| `DOMAIN`, `ACME_EMAIL` | your DNS name; an email for Let's Encrypt notices |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | `openssl rand -base64 32` each (different values) |
| `DATA_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Store a copy offline** (password manager). Without it, 2FA secrets and guest details in backups cannot be read. |
| `SMTP_*`, `MAIL_FROM` | an email provider (e.g. Amazon SES, Brevo, Postmark, Zoho). Email is required for sign-up, password reset and invitations. |
| `ZODOMUS_*` | leave `ZODOMUS_ENABLED=false` until Zodomus gives you production keys (section 5) |

Create the first platform administrator (shows a one-time password; it must set up 2FA at first sign-in):

```bash
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production run --rm api \
  node dist/cli/create-admin.js --email you@yourhotel.com --name "Your Name"
```

Open `https://<DOMAIN>`, register the owner account, verify the email, turn on 2FA, add the property.
Check **Admin → System Health & Config**: every check should be green, and one `worker` process listed.

## 3. Updating

```bash
git pull                     # or copy the new release over the folder (never overwrite infra/.env.production)
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production up -d --build
```

`migrate` runs first and the API starts only after it succeeded. Migrations are forward-only; take a backup first
(`docker compose ... exec backup sh /backup.sh`) for big updates.

## 4. Backups and restore

- The **backup** container writes `infra/backups/staysync-<date>.dump` every 24 h and keeps `BACKUP_KEEP_DAYS` (14).
- **Copy backups off the server** daily (e.g. `rclone` to object storage, or the provider's volume snapshots).
  Photos are in the `photos` Docker volume; include it in snapshots.
- Restore (stops writes first):

```bash
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production stop api worker
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production exec backup \
  pg_restore --clean --if-exists -h postgres -U staysync -d staysync /backups/staysync-YYYYmmdd-HHMMSS.dump
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.production start api worker
```

Test a restore on a spare machine at least once.

## 5. Going live with Booking.com (Zodomus production)

1. Zodomus certification done and production keys received (see [zodomus-api.md](zodomus-api.md#certification-needed-before-production)).
2. In `infra/.env.production`: `ZODOMUS_ENABLED=true`, `ZODOMUS_ENVIRONMENT=production`, the production API user and password,
   then `docker compose ... up -d`.
3. Admin → Channel Providers → **Test connection** must succeed.
4. In the Booking.com extranet, select Zodomus as connectivity provider (Zodomus support guides this).
5. Owner portal → Room & Rate Mapping: connect with the real Booking.com property ID, map **every** room and rate, Check status.
6. Set real prices and rooms to sell in the Inventory Calendar.
7. Only now set `ZODOMUS_ALLOW_PRODUCTION_WRITES=true` and restart. StaySync then sends one year of availability and rates.
   Watch Synchronization Status and the Discrepancy Center for the first day.

Sandbox and production data are kept apart: a connection made in the sandbox is not used in production.

## 6. Monitoring

- `https://<DOMAIN>/api/v1/health` (liveness) and `/api/v1/health/ready` (database) for an uptime monitor (UptimeRobot, Better Stack…).
- Admin → **System Health & Config** (workers, queue, pending migrations) and **Sync Jobs**, **API Logs**, **Zodomus Health**.
- Logs: `docker compose ... logs -f api worker web` (JSON). Guest data, card data and credentials are never logged.
- Alert on: readiness failing, no worker heartbeat for 2 minutes, failed updates in 24 h, reservation polling failing.

## 7. Settings reference (production)

| Variable | Default | Notes |
|---|---|---|
| `TRUST_PROXY` | `1` (set by compose) | exactly one proxy (Caddy) in front of the API |
| `SYNC_WORKER_ENABLED` | `false` on api, `true` on worker | background loops run only in the worker |
| `RESERVATION_POLL_INTERVAL_MS` | 60000 | booking fetch interval |
| `GUEST_DATA_RETENTION_DAYS` | 0 (keep) | erase guest details N days after check-out; check local guest-register laws |
| `PHOTO_MAX_UPLOAD_MB` | 10 | |
| `OWNER_2FA_POLICY` | `required` | |

## 8. Without Docker (advanced)

Build with `npm ci && npm run build`, run `node apps/api/dist/main.js` (API, `SYNC_WORKER_ENABLED=false`) and
`node apps/api/dist/worker.js` (worker) under systemd, serve `apps/web/dist/web/browser` with nginx using
[`infra/nginx/staysync.prod.conf`](../infra/nginx/staysync.prod.conf), and apply migrations with
`npm run db:deploy -w @staysync/api` as the schema owner.
