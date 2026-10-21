-- Free plan now allows 2 properties instead of 1.
UPDATE "plans" SET "max_properties" = 2 WHERE "code" = 'FREE';
