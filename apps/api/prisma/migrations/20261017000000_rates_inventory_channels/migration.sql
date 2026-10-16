-- CreateEnum
CREATE TYPE "RatePlanStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('DRAFT', 'ACTIVATED', 'ACTIVE', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "SyncJobKind" AS ENUM ('AVAILABILITY', 'RATES', 'RATES_DERIVED');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "rate_plans" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(1000),
    "meal_plan" VARCHAR(40),
    "single_occupancy_discount_pct" SMALLINT,
    "status" "RatePlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_days" (
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "available" SMALLINT,
    "stop_sell" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_days_pkey" PRIMARY KEY ("room_type_id","date")
);

-- CreateTable
CREATE TABLE "rate_days" (
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "rate_plan_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "price_minor" INTEGER,
    "price_single_minor" INTEGER,
    "min_stay" SMALLINT,
    "max_stay" SMALLINT,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closed_on_arrival" BOOLEAN NOT NULL DEFAULT false,
    "closed_on_departure" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_days_pkey" PRIMARY KEY ("room_type_id","rate_plan_id","date")
);

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'zodomus',
    "environment" VARCHAR(20) NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "channel_name" VARCHAR(60) NOT NULL,
    "channel_property_id" VARCHAR(40) NOT NULL,
    "price_model_id" SMALLINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ChannelConnectionStatus" NOT NULL DEFAULT 'DRAFT',
    "last_error" VARCHAR(300),
    "last_check_at" TIMESTAMPTZ(3),
    "last_check_message" VARCHAR(300),
    "channel_rooms" JSONB,
    "channel_rooms_fetched_at" TIMESTAMPTZ(3),
    "activated_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_room_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "channel_room_id" VARCHAR(40) NOT NULL,
    "channel_room_name" VARCHAR(200) NOT NULL,

    CONSTRAINT "channel_room_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_rate_mappings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "room_mapping_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "rate_plan_id" UUID NOT NULL,
    "channel_rate_id" VARCHAR(40) NOT NULL,
    "channel_rate_name" VARCHAR(200) NOT NULL,
    "max_persons" SMALLINT,

    CONSTRAINT "channel_rate_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "kind" "SyncJobKind" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "room_type_id" UUID,
    "rate_plan_id" UUID,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "calls_made" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(300),
    "provider_code" INTEGER,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_organization_id_id_key" ON "rate_plans"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_property_id_id_key" ON "rate_plans"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_property_id_code_key" ON "rate_plans"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "rate_plans_property_id_name_key" ON "rate_plans"("property_id", "name");

-- CreateIndex
CREATE INDEX "inventory_days_organization_id_property_id_date_idx" ON "inventory_days"("organization_id", "property_id", "date");

-- CreateIndex
CREATE INDEX "rate_days_organization_id_property_id_date_idx" ON "rate_days"("organization_id", "property_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_organization_id_id_key" ON "channel_connections"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_provider_environment_channel_id_channel_key" ON "channel_connections"("provider", "environment", "channel_id", "channel_property_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_property_id_provider_channel_id_key" ON "channel_connections"("property_id", "provider", "channel_id");

-- CreateIndex
CREATE INDEX "channel_room_mappings_organization_id_idx" ON "channel_room_mappings"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_room_mappings_connection_id_channel_room_id_key" ON "channel_room_mappings"("connection_id", "channel_room_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_room_mappings_connection_id_room_type_id_key" ON "channel_room_mappings"("connection_id", "room_type_id");

-- CreateIndex
CREATE INDEX "channel_rate_mappings_organization_id_idx" ON "channel_rate_mappings"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_rate_mappings_room_mapping_id_channel_rate_id_key" ON "channel_rate_mappings"("room_mapping_id", "channel_rate_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_rate_mappings_room_mapping_id_rate_plan_id_key" ON "channel_rate_mappings"("room_mapping_id", "rate_plan_id");

-- CreateIndex
CREATE INDEX "sync_jobs_status_next_attempt_at_idx" ON "sync_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "sync_jobs_connection_id_created_at_idx" ON "sync_jobs"("connection_id", "created_at");

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_days" ADD CONSTRAINT "inventory_days_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_days" ADD CONSTRAINT "rate_days_property_id_rate_plan_id_fkey" FOREIGN KEY ("property_id", "rate_plan_id") REFERENCES "rate_plans"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_room_mappings" ADD CONSTRAINT "channel_room_mappings_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "channel_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_room_mappings" ADD CONSTRAINT "channel_room_mappings_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_rate_mappings" ADD CONSTRAINT "channel_rate_mappings_room_mapping_id_fkey" FOREIGN KEY ("room_mapping_id") REFERENCES "channel_room_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_rate_mappings" ADD CONSTRAINT "channel_rate_mappings_property_id_rate_plan_id_fkey" FOREIGN KEY ("property_id", "rate_plan_id") REFERENCES "rate_plans"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "channel_connections"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
