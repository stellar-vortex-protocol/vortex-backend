-- Rollback for 20261023000001_webhooks. Drops all subscriptions and the delivery log.
DROP TABLE IF EXISTS "webhook_deliveries";
DROP TABLE IF EXISTS "webhook_subscriptions";
DROP TYPE IF EXISTS "WebhookDeliveryStatus";
DROP TYPE IF EXISTS "WebhookSubscriptionStatus";
