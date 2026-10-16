-- Creates/updates the least-privilege role the API connects as (idempotent).
-- Run as the schema owner with:  psql -v app_password=... -f app-role.sql
-- The role does not own tables, is not superuser and cannot bypass row-level security.
SELECT format('CREATE ROLE staysync_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') \gexec
SELECT format('ALTER ROLE staysync_app WITH LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO staysync_app', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO staysync_app;
-- Tables created later by migrations (run as the owner) are granted automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staysync_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staysync_app;
