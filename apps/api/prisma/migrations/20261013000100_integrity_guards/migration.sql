-- Integrity guards that Prisma's schema language cannot express.
-- Prisma ignores CHECK constraints and triggers when diffing, so these do not cause drift.

-- Organizations ----------------------------------------------------------
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_slug_format_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "organizations_currency_format_chk" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "organizations_name_not_blank_chk" CHECK (length(btrim("name")) > 0);

-- Properties -------------------------------------------------------------
ALTER TABLE "properties"
  ADD CONSTRAINT "properties_name_not_blank_chk" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "properties_currency_format_chk" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "properties_country_format_chk" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "properties_check_in_format_chk"
    CHECK ("check_in_time" IS NULL OR "check_in_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "properties_check_out_format_chk"
    CHECK ("check_out_time" IS NULL OR "check_out_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Reject unknown IANA time zones (CHECK constraints cannot query pg_timezone_names).
CREATE OR REPLACE FUNCTION staysync_validate_property_timezone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'invalid time zone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "properties_validate_timezone"
  BEFORE INSERT OR UPDATE OF "timezone" ON "properties"
  FOR EACH ROW EXECUTE FUNCTION staysync_validate_property_timezone();

-- Audit events are append-only --------------------------------------------
CREATE OR REPLACE FUNCTION staysync_audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "audit_events_no_update"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION staysync_audit_events_immutable();

CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION staysync_audit_events_immutable();
