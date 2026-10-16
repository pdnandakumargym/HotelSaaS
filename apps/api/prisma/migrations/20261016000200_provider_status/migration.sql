-- AlterTable
ALTER TABLE "integration_call_logs" ADD COLUMN     "provider_code" INTEGER,
ADD COLUMN     "provider_message" VARCHAR(300);
