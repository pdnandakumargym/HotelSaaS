-- CreateEnum
CREATE TYPE "organization_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "property_type" AS ENUM ('HOTEL', 'HOMESTAY', 'VILLA', 'BUNGALOW', 'RESORT', 'APARTMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "property_status" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "status" "organization_status" NOT NULL DEFAULT 'ACTIVE',
    "default_currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "property_type" "property_type" NOT NULL,
    "status" "property_status" NOT NULL DEFAULT 'DRAFT',
    "timezone" VARCHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "city" VARCHAR(120),
    "address_line1" VARCHAR(200),
    "address_line2" VARCHAR(200),
    "postal_code" VARCHAR(20),
    "check_in_time" VARCHAR(5),
    "check_out_time" VARCHAR(5),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "actor_user_id" UUID,
    "actor_type" VARCHAR(20) NOT NULL DEFAULT 'system',
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(60),
    "entity_id" VARCHAR(64),
    "request_id" VARCHAR(128),
    "ip_address" INET,
    "user_agent" VARCHAR(400),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "properties_organization_id_status_idx" ON "properties"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "properties_organization_id_id_key" ON "properties"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "properties_organization_id_name_key" ON "properties"("organization_id", "name");

-- CreateIndex
CREATE INDEX "audit_events_organization_id_created_at_idx" ON "audit_events"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
