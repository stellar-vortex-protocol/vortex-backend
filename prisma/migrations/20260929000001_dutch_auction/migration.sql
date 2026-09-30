ALTER TABLE "intents"
    ADD COLUMN "auction" JSONB,
    ADD COLUMN "accepted_dst_amount" TEXT;