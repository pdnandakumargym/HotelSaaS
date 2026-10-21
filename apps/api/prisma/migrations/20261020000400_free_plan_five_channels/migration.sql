-- Free plan now allows 5 channel connections instead of 2.
UPDATE "plans" SET "max_channels" = 5 WHERE "code" = 'FREE';
