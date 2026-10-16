-- CreateEnum
CREATE TYPE "IntegrationCallOutcome" AS ENUM ('SUCCESS', 'AUTH_ERROR', 'CLIENT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE');

-- CreateTable
CREATE TABLE "integration_call_logs" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "operation" VARCHAR(60) NOT NULL,
    "http_method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(200) NOT NULL,
    "http_status" INTEGER,
    "outcome" "IntegrationCallOutcome" NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error_code" VARCHAR(60),
    "error_message" VARCHAR(300),
    "request_id" VARCHAR(64),
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_reference_data" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "environment" VARCHAR(20) NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "item_count" INTEGER,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "fetched_by_id" UUID,

    CONSTRAINT "provider_reference_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_call_logs_provider_created_at_idx" ON "integration_call_logs"("provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_reference_data_provider_environment_kind_key" ON "provider_reference_data"("provider", "environment", "kind");
