import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SignatureNonceService {
  private readonly memoryNonces = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async consume(signer: string, nonce: string, expiresAt: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const normalizedSigner = signer.toLowerCase();
    if (process.env.NODE_ENV === "production" && process.env.INTENTS_PERSISTENCE !== "prisma") {
      throw new ServiceUnavailableException("Signature replay protection requires Prisma persistence in production");
    }
    if (process.env.INTENTS_PERSISTENCE === "prisma") {
      await this.prisma.$executeRaw`DELETE FROM "signature_nonces" WHERE "expires_at" <= ${now}`;
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO "signature_nonces" ("signer", "nonce", "expires_at")
        VALUES (${normalizedSigner}, ${nonce}, ${expiresAt})
        ON CONFLICT ("signer", "nonce") DO NOTHING
      `;
      return inserted === 1;
    }

    for (const [key, expiry] of this.memoryNonces) {
      if (expiry <= now) this.memoryNonces.delete(key);
    }
    const key = `${normalizedSigner}:${nonce}`;
    if (this.memoryNonces.has(key)) return false;
    this.memoryNonces.set(key, expiresAt);
    return true;
  }
}