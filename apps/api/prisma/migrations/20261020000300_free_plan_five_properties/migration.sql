-- Free plan now allows 5 properties instead of 2.
UPDATE "plans" SET "max_properties" = 5 WHERE "code" = 'FREE';
