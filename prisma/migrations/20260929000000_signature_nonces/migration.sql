CREATE TABLE "signature_nonces" (
    "signer" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" INTEGER NOT NULL,
    CONSTRAINT "signature_nonces_pkey" PRIMARY KEY ("signer", "nonce")
);

CREATE INDEX CONCURRENTLY "signature_nonces_expires_at_idx" ON "signature_nonces"("expires_at");