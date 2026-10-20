-- Milestone 6: data rules, row-level security and grants for reservations and discrepancies.

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_environment_chk" CHECK ("environment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "reservations_source_chk" CHECK ("source" IN ('QUEUE', 'SUMMARY', 'TEST')),
  ADD CONSTRAINT "reservations_dates_chk" CHECK ("check_in" IS NULL OR "check_out" IS NULL OR "check_out" > "check_in"),
  ADD CONSTRAINT "reservations_currency_chk" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "reservations_total_chk" CHECK ("total_minor" IS NULL OR "total_minor" BETWEEN 0 AND 2000000000),
  ADD CONSTRAINT "reservations_guest_count_chk" CHECK ("guest_count" IS NULL OR "guest_count" BETWEEN 0 AND 999),
  ADD CONSTRAINT "reservations_room_count_chk" CHECK ("room_count" BETWEEN 0 AND 500);

ALTER TABLE "reservation_rooms"
  ADD CONSTRAINT "reservation_rooms_dates_chk" CHECK ("check_in" IS NULL OR "check_out" IS NULL OR "check_out" > "check_in"),
  ADD CONSTRAINT "reservation_rooms_occupies_chk" CHECK (NOT "occupies_inventory" OR ("room_type_id" IS NOT NULL AND "check_in" IS NOT NULL AND "check_out" IS NOT NULL)),
  ADD CONSTRAINT "reservation_rooms_total_chk" CHECK ("total_minor" IS NULL OR "total_minor" BETWEEN 0 AND 2000000000);

ALTER TABLE "discrepancies"
  ADD CONSTRAINT "discrepancies_severity_chk" CHECK ("severity" IN ('high', 'medium', 'low')),
  ADD CONSTRAINT "discrepancies_resolved_chk" CHECK (("status" = 'OPEN') = ("resolved_at" IS NULL));

-- One open discrepancy per problem; repeated detections increase "occurrences" instead.
CREATE UNIQUE INDEX "discrepancies_open_dedupe_key" ON "discrepancies" ("organization_id", "dedupe_key") WHERE "status" = 'OPEN';

-- Nights occupied per room type (availability deduction).
CREATE INDEX "reservation_rooms_occupancy_idx" ON "reservation_rooms" ("room_type_id", "check_in", "check_out") WHERE "occupies_inventory";

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reservations', 'reservation_rooms', 'discrepancies']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON "reservations", "reservation_rooms", "discrepancies" TO staysync_app;
  END IF;
END
$$;
