-- A disconnected channel connection must not keep blocking its external property id from being
-- reused by a different StaySync property (the "one StaySync property per channel property"
-- uniqueness rule only makes sense for connections that are actually in use).
DROP INDEX "channel_connections_provider_environment_channel_id_channel_key";
CREATE UNIQUE INDEX "channel_connections_provider_environment_channel_id_channel_key" ON "channel_connections"("provider", "environment", "channel_id", "channel_property_id") WHERE "status" <> 'DISCONNECTED';
