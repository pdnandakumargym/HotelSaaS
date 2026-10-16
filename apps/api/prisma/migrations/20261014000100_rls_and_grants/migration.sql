-- Milestone 2: data integrity for auth tables, PostgreSQL row-level security (RLS)
-- for tenant-owned tables, and least-privilege grants for the runtime role.
--
-- RLS is DEFENSE IN DEPTH. The API still authorizes every request and scopes every
-- query by organization. RLS makes a forgotten filter fail closed instead of leaking data.
--
-- Session settings used by the policies (set with set_config(..., true) = transaction-local):
--   app.org_id     - the organization the current transaction acts for
--   app.rls_bypass - 'on' for system work (auth lookups, platform admin, seeding)
-- Any role can set these GUCs, so they protect against application bugs, not against
-- an attacker who can already run arbitrary SQL.

-- Auth table integrity ------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_chk" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "users_display_name_not_blank_chk" CHECK (length(btrim("display_name")) > 0),
  ADD CONSTRAINT "users_failed_login_count_chk" CHECK ("failed_login_count" >= 0);

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_after_creation_chk" CHECK ("expires_at" > "created_at");

-- RLS helpers ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION staysync_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION staysync_rls_bypass() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on'
$$;

-- organizations: a tenant context sees only its own organization row
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organizations_tenant_isolation" ON "organizations"
  USING (staysync_rls_bypass() OR "id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "id" = staysync_current_org());

-- properties
ALTER TABLE "properties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "properties" FORCE ROW LEVEL SECURITY;
CREATE POLICY "properties_tenant_isolation" ON "properties"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

-- organization_memberships
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_tenant_isolation" ON "organization_memberships"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

-- audit_events: tenants read and write only their own events; platform events need bypass
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_events_tenant_isolation" ON "audit_events"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

-- Least-privilege runtime role ---------------------------------------------
-- The API connects as "staysync_app" (created by infra/postgres/init or CI), which does
-- not own any table, so RLS always applies to it. Migrations run as the owner role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT USAGE ON SCHEMA public TO staysync_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO staysync_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO staysync_app;
    -- audit log is append-only for the application
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM staysync_app;
    -- the application never touches migration history
    REVOKE ALL ON "_prisma_migrations" FROM staysync_app;
    -- future tables created by the migration role
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staysync_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staysync_app;
  ELSE
    RAISE NOTICE 'role staysync_app not found; skipping grants (the API will need the owner role)';
  END IF;
END
$$;
