-- Milestone 3: integrity rules, row-level security for new tenant tables, plan catalog.

-- Properties --------------------------------------------------------------
ALTER TABLE "properties"
  ADD CONSTRAINT "properties_star_rating_chk" CHECK ("star_rating" IS NULL OR "star_rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "properties_latitude_chk" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "properties_longitude_chk" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "properties_contact_email_chk" CHECK ("contact_email" IS NULL OR position('@' IN "contact_email") > 1);

-- Room types ----------------------------------------------------------------
ALTER TABLE "room_types"
  ADD CONSTRAINT "room_types_name_not_blank_chk" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "room_types_code_format_chk" CHECK ("code" ~ '^[A-Z0-9_-]{1,20}$'),
  ADD CONSTRAINT "room_types_occupancy_chk" CHECK (
    "base_occupancy" >= 1 AND "max_adults" >= 1 AND "max_children" >= 0
    AND "max_occupancy" >= "base_occupancy"
    AND "max_occupancy" <= "max_adults" + "max_children"
    AND "max_occupancy" <= 50
  ),
  ADD CONSTRAINT "room_types_size_chk" CHECK ("size_sqm" IS NULL OR "size_sqm" > 0);

-- Rooms -------------------------------------------------------------------------
ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

-- Invitations -------------------------------------------------------------------
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_email_normalized_chk" CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1),
  ADD CONSTRAINT "invitations_expiry_chk" CHECK ("expires_at" > "created_at");

-- Users: pending email must be normalized too
ALTER TABLE "users"
  ADD CONSTRAINT "users_pending_email_normalized_chk" CHECK ("pending_email" IS NULL OR ("pending_email" = lower(btrim("pending_email")) AND position('@' IN "pending_email") > 1));

-- Support access ------------------------------------------------------------------
ALTER TABLE "support_access_requests"
  ADD CONSTRAINT "support_access_duration_chk" CHECK ("duration_minutes" BETWEEN 15 AND 480),
  ADD CONSTRAINT "support_access_reason_chk" CHECK (length(btrim("reason")) >= 10);

-- Plans -----------------------------------------------------------------------------
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_limits_chk" CHECK ("max_properties" >= 1 AND "max_users" >= 1 AND "max_channels" >= 0 AND "price_monthly_minor" >= 0);

-- Plan catalog from the product deck (prices in paise; editable later by platform admins).
INSERT INTO "plans" ("id", "code", "name", "max_properties", "max_users", "max_channels", "price_monthly_minor", "currency", "trial_days", "sort_order")
VALUES
  (gen_random_uuid(), 'FREE',    'Free',    1,  2,  2,      0, 'INR', 30, 1),
  (gen_random_uuid(), 'PRO',     'Pro',     3,  5,  5, 299900, 'INR',  0, 2),
  (gen_random_uuid(), 'PREMIUM', 'Premium', 20, 25, 10, 499900, 'INR',  0, 3)
ON CONFLICT ("code") DO NOTHING;

-- Every existing organization starts on the Free plan (30-day trial).
INSERT INTO "subscriptions" ("id", "organization_id", "plan_id", "status", "trial_ends_at", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", p."id", 'TRIALING', now() + interval '30 days', now(), now()
FROM "organizations" o CROSS JOIN "plans" p
WHERE p."code" = 'FREE' AND NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."organization_id" = o."id");

-- Row-level security for new tenant tables ---------------------------------------
ALTER TABLE "room_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "room_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY "room_types_tenant_isolation" ON "room_types"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

ALTER TABLE "rooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rooms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rooms_tenant_isolation" ON "rooms"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invitations_tenant_isolation" ON "invitations"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_tenant_isolation" ON "subscriptions"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

ALTER TABLE "support_access_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_access_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "support_access_tenant_isolation" ON "support_access_requests"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

-- Grants for the runtime role (new tables get default privileges; plans are read-only) --
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "room_types", "rooms", "invitations", "subscriptions", "support_access_requests" TO staysync_app;
    GRANT SELECT ON "plans" TO staysync_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "plans" FROM staysync_app;
  END IF;
END
$$;
