-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'MODIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiscrepancyKind" AS ENUM ('OVERBOOKING', 'UNMAPPED_ROOM', 'RESERVATION_INCOMPLETE', 'RESERVATION_FETCH_FAILED', 'UNKNOWN_RESERVATION', 'SYNC_FAILED', 'POLL_FAILED');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- AlterTable
ALTER TABLE "channel_connections" ADD COLUMN     "reservations_poll_error" VARCHAR(300),
ADD COLUMN     "reservations_poll_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reservations_polled_at" TIMESTAMPTZ(3),
ADD COLUMN     "summary_imported_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "channel_name" VARCHAR(60) NOT NULL,
    "channel_reservation_id" VARCHAR(64) NOT NULL,
    "status" "ReservationStatus" NOT NULL,
    "channel_status" VARCHAR(40),
    "check_in" DATE,
    "check_out" DATE,
    "currency" CHAR(3),
    "total_minor" INTEGER,
    "guest_count" SMALLINT,
    "room_count" SMALLINT NOT NULL DEFAULT 0,
    "guest_enc" TEXT,
    "payload_enc" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" VARCHAR(300),
    "source" VARCHAR(20) NOT NULL,
    "channel_changed_at" VARCHAR(40),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_rooms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "channel_room_id" VARCHAR(40),
    "channel_room_name" VARCHAR(200),
    "channel_rate_id" VARCHAR(40),
    "room_type_id" UUID,
    "rate_plan_id" UUID,
    "check_in" DATE,
    "check_out" DATE,
    "guest_count" SMALLINT,
    "total_minor" INTEGER,
    "meal_plan" VARCHAR(200),
    "occupies_inventory" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "reservation_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discrepancies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "connection_id" UUID,
    "reservation_id" UUID,
    "sync_job_id" UUID,
    "kind" "DiscrepancyKind" NOT NULL,
    "severity" VARCHAR(10) NOT NULL,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "message" VARCHAR(300) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" VARCHAR(200) NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "auto_resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution_note" VARCHAR(500),

    CONSTRAINT "discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reservations_organization_id_property_id_check_in_idx" ON "reservations"("organization_id", "property_id", "check_in");

-- CreateIndex
CREATE INDEX "reservations_property_id_status_check_in_check_out_idx" ON "reservations"("property_id", "status", "check_in", "check_out");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_organization_id_id_key" ON "reservations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_connection_id_channel_reservation_id_key" ON "reservations"("connection_id", "channel_reservation_id");

-- CreateIndex
CREATE INDEX "reservation_rooms_organization_id_idx" ON "reservation_rooms"("organization_id");

-- CreateIndex
CREATE INDEX "reservation_rooms_reservation_id_idx" ON "reservation_rooms"("reservation_id");

-- CreateIndex
CREATE INDEX "reservation_rooms_room_type_id_check_in_check_out_idx" ON "reservation_rooms"("room_type_id", "check_in", "check_out");

-- CreateIndex
CREATE INDEX "discrepancies_organization_id_status_last_seen_at_idx" ON "discrepancies"("organization_id", "status", "last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "discrepancies_property_id_status_idx" ON "discrepancies"("property_id", "status");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "channel_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_rooms" ADD CONSTRAINT "reservation_rooms_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_organization_id_connection_id_fkey" FOREIGN KEY ("organization_id", "connection_id") REFERENCES "channel_connections"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_organization_id_reservation_id_fkey" FOREIGN KEY ("organization_id", "reservation_id") REFERENCES "reservations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
