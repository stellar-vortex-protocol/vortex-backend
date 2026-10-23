/**
 * IntentsController × destination preflight (issue #439): creation is refused
 * when the destination cannot receive the asset, and the accept-time re-check
 * refuses an accept (and notifies the user) when the trustline disappeared.
 */
import { ConfigService } from "@nestjs/config";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { buildAcceptMessage } from "../common/stellar-signature";
import { IntentsController } from "./intents.controller";
import { IntentsService } from "./intents.service";
import { Intent } from "./intents.types";
import { SolversService } from "../solvers/solvers.service";
import { IntentsGateway } from "./intents.gateway";
import { TokensService } from "../tokens/tokens.service";
import { RoutingService } from "../routing/routing.service";
import { KillSwitchService } from "../killswitch/killswitch.service";
import {
  DestinationLedgerReader,
  DestinationPreflightError,
  DestinationPreflightService,
  HorizonAccountRecord,
} from "../soroban/destination-preflight.service";
import { CreateIntentDto } from "./dto/create-intent.dto";

const issuer = Keypair.random().publicKey();
const USDC_SAC = new Asset("USDC", issuer).contractId(Networks.TESTNET);

class Ledger implements DestinationLedgerReader {
  accounts = new Map<string, HorizonAccountRecord>();
  async loadAccount(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async sacUnderlyingAsset() {
    return { code: "USDC", issuer };
  }
  async contractHolderAuthorized() {
    return true;
  }
  setTrustline(id: string, present: boolean) {
    this.accounts.set(id, {
      account_id: id,
      balances: present
        ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0", limit: "1000", is_authorized: true }]
        : [],
    });
  }
}

function preflight(ledger: Ledger): DestinationPreflightService {
  const values: Record<string, unknown> = {
    destinationPreflight: { enabled: true, failOpen: true, cacheTtlMs: 60_000 },
    "stellar.network": "testnet",
    "stellar.horizonUrl": "https://horizon-testnet.stellar.org",
    "stellar.sorobanRpcUrl": "https://soroban-testnet.stellar.org",
  };
  return new DestinationPreflightService({ get: (k: string) => values[k] } as unknown as ConfigService<AppConfig, true>, ledger);
}

describe("IntentsController destination preflight (issue #439)", () => {
  const user = Keypair.random();
  const solver = Keypair.random();
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = {
    intentId: "pf-intent",
    user: user.publicKey(),
    srcChain: "ethereum",
    srcToken: { address: "0xabc", symbol: "USDC", name: "USD Coin", decimals: 6, chain: "ethereum" },
    srcAmount: "1000",
    dstToken: { contract: USDC_SAC, symbol: "USDC", decimals: 7 },
    minDstAmount: "900",
    state: "open",
    createdAt: now - 60,
    deadline: now + 600,
  };

  function setup() {
    const ledger = new Ledger();
    const service = {
      get: jest.fn().mockResolvedValue(intent),
      countOpenByUser: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(intent),
      acceptIfOpen: jest.fn().mockResolvedValue({ ...intent, state: "accepted", solver: solver.publicKey() }),
      appendAuditEntry: jest.fn(),
    } as unknown as jest.Mocked<IntentsService>;
    const gateway = { broadcast: jest.fn() } as unknown as jest.Mocked<IntentsGateway>;
    const tokens = {
      resolveSrcTokenOrThrow: jest.fn().mockResolvedValue({ priceUSD: 1 }),
      resolveDstTokenOrThrow: jest.fn().mockResolvedValue({ priceUSD: 1 }),
    } as unknown as TokensService;
    const solvers = {
      get: jest.fn().mockResolvedValue({ isActive: true, bondAmount: "100" }),
      isSuspended: jest.fn().mockReturnValue(false),
    } as unknown as SolversService;
    const killSwitch = { evaluateTarget: jest.fn().mockReturnValue({ paused: false }) } as unknown as KillSwitchService;
    const config = { get: jest.fn().mockReturnValue([]) } as unknown as ConfigService<AppConfig, true>;
    const controller = new IntentsController(
      service,
      solvers,
      gateway,
      tokens,
      {} as RoutingService,
      killSwitch,
      config,
      preflight(ledger),
    );
    return { controller, service, gateway, ledger };
  }

  const createDto = (): CreateIntentDto => ({
    user: user.publicKey(),
    srcChain: "ethereum",
    srcTokenAddress: "0xabc",
    srcTokenSymbol: "USDC",
    srcTokenDecimals: 6,
    srcAmount: "1000",
    dstTokenContract: USDC_SAC,
    dstTokenSymbol: "USDC",
    dstTokenDecimals: 7,
    minDstAmount: "900",
  });

  const acceptDto = () => ({
    solver: solver.publicKey(),
    signature: solver.sign(Buffer.from(buildAcceptMessage(intent.intentId, solver.publicKey()))).toString("base64"),
  });

  it("refuses to create an intent for a destination account that does not exist", async () => {
    const { controller, service } = setup();
    const err = await controller.create(createDto()).catch((e) => e);
    expect(err).toBeInstanceOf(DestinationPreflightError);
    expect(err.code).toBe("DST_ACCOUNT_NOT_FOUND");
    expect(service.create).not.toHaveBeenCalled();
  });

  it("refuses to create an intent without a trustline for the destination asset", async () => {
    const { controller, service, ledger } = setup();
    ledger.setTrustline(user.publicKey(), false);
    await expect(controller.create(createDto())).rejects.toMatchObject({ code: "DST_TRUSTLINE_MISSING" });
    expect(service.create).not.toHaveBeenCalled();
  });

  it("creates the intent when the destination can receive it", async () => {
    const { controller, service, ledger } = setup();
    ledger.setTrustline(user.publicKey(), true);
    await expect(controller.create(createDto())).resolves.toBe(intent);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it("re-checks at accept time: a removed trustline rejects the accept and notifies the user", async () => {
    const { controller, service, gateway, ledger } = setup();
    ledger.setTrustline(user.publicKey(), true);
    await controller.create(createDto()); // warms the cache with an "ok" snapshot
    ledger.setTrustline(user.publicKey(), false); // user removed the trustline

    await expect(controller.accept(intent.intentId, acceptDto())).rejects.toMatchObject({
      code: "DST_TRUSTLINE_MISSING",
    });
    expect(service.acceptIfOpen).not.toHaveBeenCalled();
    expect(gateway.broadcast).toHaveBeenCalledWith({
      type: "intent_destination_invalid",
      intentId: intent.intentId,
      user: user.publicKey(),
      code: "DST_TRUSTLINE_MISSING",
    });
    expect(service.appendAuditEntry).toHaveBeenCalledWith(
      intent.intentId,
      "open",
      "system",
      "destination preflight failed",
      { code: "DST_TRUSTLINE_MISSING" },
    );
  });

  it("accepts when the destination is still deliverable", async () => {
    const { controller, service, ledger } = setup();
    ledger.setTrustline(user.publicKey(), true);
    await expect(controller.accept(intent.intentId, acceptDto())).resolves.toMatchObject({ state: "accepted" });
    expect(service.acceptIfOpen).toHaveBeenCalled();
  });
});
