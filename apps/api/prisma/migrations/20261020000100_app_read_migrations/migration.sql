-- Let the API role read which migrations are applied (shown on the admin System Health page). Read-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT SELECT ON "_prisma_migrations" TO staysync_app;
  END IF;
END
$$;
