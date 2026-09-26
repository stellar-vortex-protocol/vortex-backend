import { ConfigService } from "@nestjs/config";
import { Keypair } from "@stellar/stellar-sdk";
import { ChannelPoolService } from "./channel-pool.service";
import { SorobanService } from "./soroban.service";
import { MetricsService } from "../metrics/metrics.service";
import { AppConfig } from "../config/configuration";

// Generate a pair of real throwaway testnet keypairs for tests
const KP1 = Keypair.random();
const KP2 = Keypair.random();

function makeConfigService(secrets: string[]): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => {
      if (key === "stellar.channelSecretKeys") return secrets.join(",");
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;
}

function makeSoroban(sequence = "100"): SorobanService {
  return {
    getAccount: jest.fn().mockResolvedValue({
      sequenceNumber: () => sequence,
    }),
  } as unknown as SorobanService;
}

function makeMetrics(): MetricsService {
  return {
    channelPoolUtilisation: { set: jest.fn() },
    channelLeaseWaitTime: { observe: jest.fn() },
    channelBadSeqResyncs: { inc: jest.fn() },
  } as unknown as MetricsService;
}

describe("ChannelPoolService", () => {
  it("isAvailable() returns false when no channel keys configured", () => {
    const svc = new ChannelPoolService(makeSoroban(), makeMetrics(), makeConfigService([]));
    expect(svc.isAvailable()).toBe(false);
    expect(svc.size).toBe(0);
  });

  it("isAvailable() returns true when channels are configured", () => {
    const svc = new ChannelPoolService(makeSoroban(), makeMetrics(), makeConfigService([KP1.secret()]));
    expect(svc.isAvailable()).toBe(true);
    expect(svc.size).toBe(1);
  });

  it("lease() returns a handle with publicKey and sequence", async () => {
    const soroban = makeSoroban("200");
    const svc = new ChannelPoolService(soroban, makeMetrics(), makeConfigService([KP1.secret()]));
    await svc.onModuleInit();

    const handle = await svc.lease();

    expect(handle.publicKey).toBe(KP1.publicKey());
    expect(handle.sequence).toBe("201"); // 200 + 1
    expect(handle.keypair).toBeDefined();
    expect(typeof handle.release).toBe("function");
    handle.release(true);
  });

  it("release(true) frees the channel for next lease", async () => {
    const soroban = makeSoroban("100");
    const svc = new ChannelPoolService(soroban, makeMetrics(), makeConfigService([KP1.secret()]));
    await svc.onModuleInit();

    const h1 = await svc.lease();
    h1.release(true);

    // Should be leaseable again immediately
    const h2 = await svc.lease();
    expect(h2.publicKey).toBe(KP1.publicKey());
    h2.release(true);
  });

  it("release(false) nullifies cachedSequence to force re-sync", async () => {
    const soroban = makeSoroban("100");
    const metrics = makeMetrics();
    const svc = new ChannelPoolService(soroban, metrics, makeConfigService([KP1.secret()]));
    await svc.onModuleInit();

    const h1 = await svc.lease();
    h1.release(false);

    expect(metrics.channelBadSeqResyncs.inc).toHaveBeenCalled();

    // Next lease should re-fetch sequence from network
    const h2 = await svc.lease();
    // getAccount is called once for onModuleInit + once for the re-sync on lease
    expect(soroban.getAccount).toHaveBeenCalledTimes(2);
    h2.release(true);
  });

  it("3rd concurrent lease waits while 2 channels are busy", async () => {
    const soroban = makeSoroban("100");
    const svc = new ChannelPoolService(soroban, makeMetrics(), makeConfigService([KP1.secret(), KP2.secret()]));
    await svc.onModuleInit();

    const h1 = await svc.lease();
    const h2 = await svc.lease();

    let h3Resolved = false;
    const h3Promise = svc.lease().then((h) => {
      h3Resolved = true;
      return h;
    });

    // h3 should still be waiting
    await new Promise((r) => setTimeout(r, 10));
    expect(h3Resolved).toBe(false);

    // Releasing h1 should unblock h3
    h1.release(true);
    const h3 = await h3Promise;
    expect(h3Resolved).toBe(true);
    h2.release(true);
    h3.release(true);
  });

  it("evicts expired leases on the next lease() call", async () => {
    jest.useFakeTimers();
    const soroban = makeSoroban("100");
    const svc = new ChannelPoolService(soroban, makeMetrics(), makeConfigService([KP1.secret()]));
    await svc.onModuleInit();

    const h1 = await svc.lease();
    // Advance time past the 30 s lease timeout
    jest.advanceTimersByTime(31_000);

    // A new lease() call should evict the expired lease and return a new handle
    const h2 = await svc.lease();
    expect(h2.publicKey).toBe(KP1.publicKey());
    h2.release(true);
    jest.useRealTimers();
    // Suppress the original handle's release (it was evicted)
    h1.release(true);
  });
});
