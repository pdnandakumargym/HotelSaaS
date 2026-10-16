-- Milestone 5: data rules, row-level security and grants for rate plans, calendar, channel mapping and sync jobs.

ALTER TABLE "rate_plans"
  ADD CONSTRAINT "rate_plans_code_chk" CHECK ("code" ~ '^[A-Z0-9_-]{1,20}$'),
  ADD CONSTRAINT "rate_plans_single_discount_chk" CHECK ("single_occupancy_discount_pct" IS NULL OR "single_occupancy_discount_pct" BETWEEN 0 AND 90);

ALTER TABLE "inventory_days"
  ADD CONSTRAINT "inventory_days_available_chk" CHECK ("available" IS NULL OR "available" BETWEEN 0 AND 9999);

ALTER TABLE "rate_days"
  ADD CONSTRAINT "rate_days_price_chk" CHECK ("price_minor" IS NULL OR "price_minor" BETWEEN 0 AND 1000000000),
  ADD CONSTRAINT "rate_days_price_single_chk" CHECK ("price_single_minor" IS NULL OR "price_single_minor" BETWEEN 0 AND 1000000000),
  ADD CONSTRAINT "rate_days_min_stay_chk" CHECK ("min_stay" IS NULL OR "min_stay" BETWEEN 0 AND 31),
  ADD CONSTRAINT "rate_days_max_stay_chk" CHECK ("max_stay" IS NULL OR "max_stay" BETWEEN 0 AND 31),
  ADD CONSTRAINT "rate_days_stay_order_chk" CHECK ("min_stay" IS NULL OR "max_stay" IS NULL OR "max_stay" = 0 OR "min_stay" <= "max_stay");

ALTER TABLE "channel_connections"
  ADD CONSTRAINT "channel_connections_environment_chk" CHECK ("environment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "channel_connections_property_id_chk" CHECK ("channel_property_id" ~ '^[A-Za-z0-9_-]{1,40}$'),
  ADD CONSTRAINT "channel_connections_price_model_chk" CHECK ("price_model_id" BETWEEN 1 AND 4),
  ADD CONSTRAINT "channel_connections_currency_chk" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "sync_jobs"
  ADD CONSTRAINT "sync_jobs_range_chk" CHECK ("date_to" > "date_from" AND "date_to" <= "date_from" + 400),
  ADD CONSTRAINT "sync_jobs_attempts_chk" CHECK ("attempts" BETWEEN 0 AND 100);

-- Tenant isolation (same policy shape as the other tenant tables).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rate_plans', 'inventory_days', 'rate_days', 'channel_connections', 'channel_room_mappings', 'channel_rate_mappings', 'sync_jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org()) WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_plans", "inventory_days", "rate_days", "channel_connections",
      "channel_room_mappings", "channel_rate_mappings", "sync_jobs" TO staysync_app;
  END IF;
END
$$;
