-- CreateEnum
CREATE TYPE "room_type_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "room_status" AS ENUM ('AVAILABLE', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "support_access_status" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'REVOKED');

-- AlterEnum
ALTER TYPE "one_time_token_purpose" ADD VALUE 'EMAIL_CHANGE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pending_email" VARCHAR(254);

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cancellation_policy" VARCHAR(4000),
ADD COLUMN     "contact_email" VARCHAR(254),
ADD COLUMN     "contact_phone" VARCHAR(40),
ADD COLUMN     "description" VARCHAR(4000),
ADD COLUMN     "house_rules" VARCHAR(4000),
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "star_rating" SMALLINT,
ADD COLUMN     "state" VARCHAR(120);

-- CreateTable
CREATE TABLE "room_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(2000),
    "base_occupancy" SMALLINT NOT NULL DEFAULT 2,
    "max_adults" SMALLINT NOT NULL DEFAULT 2,
    "max_children" SMALLINT NOT NULL DEFAULT 0,
    "max_occupancy" SMALLINT NOT NULL DEFAULT 2,
    "bed_configuration" VARCHAR(200),
    "size_sqm" DECIMAL(7,2),
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "room_type_status" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "floor" VARCHAR(20),
    "status" "room_status" NOT NULL DEFAULT 'AVAILABLE',
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "organization_role" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "max_properties" INTEGER NOT NULL,
    "max_users" INTEGER NOT NULL,
    "max_channels" INTEGER NOT NULL,
    "price_monthly_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'TRIALING',
    "trial_ends_at" TIMESTAMPTZ(3),
    "current_period_end" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_access_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "status" "support_access_status" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_types_organization_id_property_id_idx" ON "room_types"("organization_id", "property_id");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_organization_id_id_key" ON "room_types"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_property_id_id_key" ON "room_types"("property_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_property_id_code_key" ON "room_types"("property_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_property_id_name_key" ON "room_types"("property_id", "name");

-- CreateIndex
CREATE INDEX "rooms_organization_id_property_id_idx" ON "rooms"("organization_id", "property_id");

-- CreateIndex
CREATE INDEX "rooms_room_type_id_idx" ON "rooms"("room_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_property_id_name_key" ON "rooms"("property_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_email_idx" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE INDEX "support_access_requests_organization_id_status_idx" ON "support_access_requests"("organization_id", "status");

-- CreateIndex
CREATE INDEX "support_access_requests_requested_by_id_status_idx" ON "support_access_requests"("requested_by_id", "status");

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organization_id_property_id_fkey" FOREIGN KEY ("organization_id", "property_id") REFERENCES "properties"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_property_id_room_type_id_fkey" FOREIGN KEY ("property_id", "room_type_id") REFERENCES "room_types"("property_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_access_requests" ADD CONSTRAINT "support_access_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
