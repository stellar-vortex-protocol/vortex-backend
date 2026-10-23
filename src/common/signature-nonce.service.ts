import { Injectable, Logger, Optional, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createClient, RedisClientType } from "redis";

export interface SignatureNonceStore {
  consume(signer: string, nonce: string, expiresAt: number): Promise<boolean>;
}

export class PrismaSignatureNonceStore implements SignatureNonceStore {
  constructor(private readonly prisma: PrismaService) {}

  async consume(signer: string, nonce: string, expiresAt: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const normalizedSigner = signer.toLowerCase();
    await this.prisma.$executeRaw`DELETE FROM "signature_nonces" WHERE "expires_at" <= ${now}`;
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "signature_nonces" ("signer", "nonce", "expires_at")
      VALUES (${normalizedSigner}, ${nonce}, ${expiresAt})
      ON CONFLICT ("signer", "nonce") DO NOTHING
    `;
    return inserted === 1;
  }
}

export class MemorySignatureNonceStore implements SignatureNonceStore {
  private readonly memoryNonces = new Map<string, number>();

  async consume(signer: string, nonce: string, expiresAt: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const normalizedSigner = signer.toLowerCase();
    for (const [key, expiry] of this.memoryNonces) {
      if (expiry <= now) this.memoryNonces.delete(key);
    }
    const key = `${normalizedSigner}:${nonce}`;
    if (this.memoryNonces.has(key)) return false;
    this.memoryNonces.set(key, expiresAt);
    return true;
  }
}

export class RedisSignatureNonceStore implements SignatureNonceStore {
  private readonly logger = new Logger(RedisSignatureNonceStore.name);

  constructor(private readonly client: RedisClientType) {}

  async consume(signer: string, nonce: string, expiresAt: number): Promise<boolean> {
    const normalizedSigner = signer.toLowerCase();
    const key = `${normalizedSigner}:${nonce}`;
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(1, expiresAt - now);
    try {
      const result = await this.client.set(key, "1", { NX: true, EX: ttl });
      return result === "OK";
    } catch (err) {
      this.logger.error(`Redis signature nonce check failed: ${(err as Error).message}`);
      return false;
    }
  }
}

function buildRedisClient(): RedisClientType {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const client = createClient({ url }) as RedisClientType;
  client.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("Redis signature nonce client error", err);
  });
  void client.connect();
  return client;
}

@Injectable()
export class SignatureNonceService {
  private readonly store: SignatureNonceStore;
  private readonly isProduction = process.env.NODE_ENV === "production";

  constructor(
    private readonly prisma: PrismaService,
    @Optional() redisClient?: RedisClientType,
  ) {
    const backend = (
      process.env.SIGNATURE_NONCE_STORE ??
      (process.env.INTENTS_PERSISTENCE === "prisma" ? "prisma" : "memory")
    ).toLowerCase();

    if (this.isProduction && backend === "memory") {
      throw new ServiceUnavailableException(
        "Signature replay protection requires Prisma or Redis persistence in production",
      );
    }

    switch (backend) {
      case "prisma":
        this.store = new PrismaSignatureNonceStore(this.prisma);
        break;
      case "redis":
        this.store = new RedisSignatureNonceStore(redisClient ?? buildRedisClient());
        break;
      case "memory":
        this.store = new MemorySignatureNonceStore();
        break;
      default:
        throw new ServiceUnavailableException(
          `Unknown SIGNATURE_NONCE_STORE backend: ${backend}`,
        );
    }
  }

  async consume(signer: string, nonce: string, expiresAt: number): Promise<boolean> {
    if (this.isProduction && this.store instanceof MemorySignatureNonceStore) {
      throw new ServiceUnavailableException(
        "Signature replay protection requires Prisma or Redis persistence in production",
      );
    }
    try {
      return await this.store.consume(signer, nonce, expiresAt);
    } catch {
      return false;
    }
  }
}
