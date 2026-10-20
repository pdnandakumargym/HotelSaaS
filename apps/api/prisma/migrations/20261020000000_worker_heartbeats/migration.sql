-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" VARCHAR(120) NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "version" VARCHAR(40) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_heartbeats_last_seen_at_idx" ON "worker_heartbeats"("last_seen_at");

-- Platform table (no tenant data): readable by the API role; not exposed to tenants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_heartbeats" TO staysync_app;
  END IF;
END
$$;
