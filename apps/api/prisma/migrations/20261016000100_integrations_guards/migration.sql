-- Milestone 4: guards and grants for channel-provider tables (hand-written; Prisma ignores CHECKs when diffing).
-- These tables are platform-level (no tenant data, no guest data), so they carry no organization_id and no RLS.

ALTER TABLE "integration_call_logs"
  ADD CONSTRAINT "integration_call_logs_duration_chk" CHECK ("duration_ms" >= 0),
  ADD CONSTRAINT "integration_call_logs_attempts_chk" CHECK ("attempts" BETWEEN 1 AND 10),
  ADD CONSTRAINT "integration_call_logs_environment_chk" CHECK ("environment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "integration_call_logs_method_chk" CHECK ("http_method" IN ('GET', 'POST')),
  ADD CONSTRAINT "integration_call_logs_status_chk" CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599);

ALTER TABLE "provider_reference_data"
  ADD CONSTRAINT "provider_reference_data_environment_chk" CHECK ("environment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "provider_reference_data_kind_chk" CHECK ("kind" IN ('account', 'channels', 'currencies', 'price_models')),
  ADD CONSTRAINT "provider_reference_data_size_chk" CHECK (pg_column_size("payload") <= 1048576);

-- Call logs are append-only for the app (DELETE allowed for retention clean-up, never UPDATE).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT SELECT, INSERT, DELETE ON "integration_call_logs" TO staysync_app;
    REVOKE UPDATE, TRUNCATE ON "integration_call_logs" FROM staysync_app;
    GRANT SELECT, INSERT, UPDATE ON "provider_reference_data" TO staysync_app;
    REVOKE DELETE, TRUNCATE ON "provider_reference_data" FROM staysync_app;
  END IF;
END
$$;
