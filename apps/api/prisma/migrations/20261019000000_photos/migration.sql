-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID,
    "storage_key" VARCHAR(120) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "caption" VARCHAR(200),
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "photos_storage_key_key" ON "photos"("storage_key");

-- CreateIndex
CREATE INDEX "photos_organization_id_property_id_room_type_id_sort_order_idx" ON "photos"("organization_id", "property_id", "room_type_id", "sort_order");

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data rules
ALTER TABLE "photos"
  ADD CONSTRAINT "photos_content_type_chk" CHECK ("content_type" IN ('image/jpeg')),
  ADD CONSTRAINT "photos_dimensions_chk" CHECK ("width" BETWEEN 1 AND 10000 AND "height" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "photos_bytes_chk" CHECK ("bytes" BETWEEN 1 AND 20000000),
  ADD CONSTRAINT "photos_sha256_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "photos_storage_key_chk" CHECK ("storage_key" ~ '^[0-9a-f-]{36}\.jpg$');

-- At most one main photo per property (property photos) and per room type.
CREATE UNIQUE INDEX "photos_one_main_property" ON "photos" ("property_id") WHERE "is_main" AND "room_type_id" IS NULL;
CREATE UNIQUE INDEX "photos_one_main_room_type" ON "photos" ("room_type_id") WHERE "is_main" AND "room_type_id" IS NOT NULL;

ALTER TABLE "photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "photos" FORCE ROW LEVEL SECURITY;
CREATE POLICY "photos_tenant_isolation" ON "photos"
  USING (staysync_rls_bypass() OR "organization_id" = staysync_current_org())
  WITH CHECK (staysync_rls_bypass() OR "organization_id" = staysync_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "photos" TO staysync_app;
  END IF;
END
$$;
