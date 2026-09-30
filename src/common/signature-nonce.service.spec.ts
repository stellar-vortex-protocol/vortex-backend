import { PrismaService } from "../prisma/prisma.service";
import { SignatureNonceService } from "./signature-nonce.service";

describe("SignatureNonceService", () => {
  const previousPersistence = process.env.INTENTS_PERSISTENCE;

  afterEach(() => {
    if (previousPersistence === undefined) delete process.env.INTENTS_PERSISTENCE;
    else process.env.INTENTS_PERSISTENCE = previousPersistence;
  });

  it("accepts a nonce once for a signer and rejects reuse", async () => {
    process.env.INTENTS_PERSISTENCE = "memory";
    const service = new SignatureNonceService({} as PrismaService);
    const expiry = Math.floor(Date.now() / 1000) + 60;

    await expect(service.consume("GSigner", "nonce-123", expiry)).resolves.toBe(true);
    await expect(service.consume("gsigner", "nonce-123", expiry)).resolves.toBe(false);
    await expect(service.consume("GOther", "nonce-123", expiry)).resolves.toBe(true);
  });

  it("uses the database unique key for atomic cross-replica consumption", async () => {
    process.env.INTENTS_PERSISTENCE = "prisma";
    const executeRaw = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const service = new SignatureNonceService({ $executeRaw: executeRaw } as unknown as PrismaService);

    await expect(service.consume("GSigner", "nonce-123", 1_900_000_000)).resolves.toBe(false);
    await expect(service.consume("GSigner", "nonce-456", 1_900_000_000)).resolves.toBe(true);
    expect(executeRaw).toHaveBeenCalledTimes(4);
  });
});