import { ConfigService } from "@nestjs/config";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { StellarTxService, InvokeContractResult } from "./stellar-tx.service";
import {
  SettlementContractClient,
  RegisterIntentParams,
  AcceptIntentParams,
  SettleFillParams,
  CancelIntentParams,
  MarkExpiredParams,
} from "./settlement-contract.client";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const USER_ADDRESS = "GCIVTVJRRSXWLJ2GLUIONABNMI3MGFW6NJXTKCXFVOBSTDAROJ4DDRNP";
const SOLVER_ADDRESS = "GBHF6RPZQG6AJGFLCQ4CEF6IINEGJES3X7XJXW6TSTMS2X4LDQV77OKT";
const DST_TOKEN_ADDRESS = "GDN7FEMGYPDMNJLBNWUCP2U5YVN6GAGZEQZ5HB5GVOUMJ6Y4WRAXAMYJ";

const DRY_RUN_RESULT: InvokeContractResult = {
  hash: "dry-run-no-hash",
  status: "DRY_RUN",
  dryRun: true,
};

function makeClient() {
  const stellarTxService = {
    invokeContract: jest.fn<Promise<InvokeContractResult>, [Parameters<StellarTxService["invokeContract"]>[0]]>()
      .mockResolvedValue(DRY_RUN_RESULT),
  } as unknown as jest.Mocked<StellarTxService>;

  const configService = {
    get: jest.fn((key: string) => {
      if (key === "stellar.settlementContractId") return CONTRACT_ID;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;

  const client = new SettlementContractClient(
    stellarTxService,
    configService,
  );

  return { client, stellarTxService, configService };
}

// ---------------------------------------------------------------------------
// Helpers to decode ScVal args from recorded calls
// ---------------------------------------------------------------------------

function getInvokeArgs(stellarTxService: jest.Mocked<StellarTxService>, callIndex = 0): xdr.ScVal[] {
  return stellarTxService.invokeContract.mock.calls[callIndex][0].args;
}

function scValIsString(scVal: xdr.ScVal, expected: string): boolean {
  return scVal.switch().name === "scvString" && scVal.str().toString() === expected;
}

function scValIsSymbol(scVal: xdr.ScVal, expected: string): boolean {
  return scVal.switch().name === "scvSymbol" && scVal.sym().toString() === expected;
}

function scValIsAddress(scVal: xdr.ScVal, expectedAddr: string): boolean {
  if (scVal.switch().name !== "scvAddress") return false;
  // Round-trip through Address to compare
  const decoded = Address.fromScVal(scVal);
  return decoded.toString() === expectedAddr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SettlementContractClient", () => {
  // -------------------------------------------------------------------------
  // registerIntent
  // -------------------------------------------------------------------------
  describe("registerIntent", () => {
    const params: RegisterIntentParams = {
      intentId: "intent-001",
      user: USER_ADDRESS,
      srcChain: "stellar",
      srcToken: "USDC",
      srcAmount: 1_000_000n,
      dstToken: DST_TOKEN_ADDRESS,
      minDstAmount: 990_000n,
      deadline: 1_700_000_000,
    };

    it("calls invokeContract with method=register_intent and the correct contractId", async () => {
      const { client, stellarTxService } = makeClient();

      await client.registerIntent(params);

      expect(stellarTxService.invokeContract).toHaveBeenCalledTimes(1);
      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(CONTRACT_ID);
      expect(call.method).toBe("register_intent");
    });

    it("encodes intentId as an ScVal string at arg[0]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsString(args[0], "intent-001")).toBe(true);
    });

    it("encodes user as an Address ScVal at arg[1]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsAddress(args[1], USER_ADDRESS)).toBe(true);
    });

    it("encodes srcChain as a symbol at arg[2]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsSymbol(args[2], "stellar")).toBe(true);
    });

    it("encodes srcAmount as i128 at arg[4]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      const expected = nativeToScVal(1_000_000n, { type: "i128" });
      expect(args[4].toXDR("base64")).toBe(expected.toXDR("base64"));
    });

    it("encodes dstToken as an Address ScVal at arg[5]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsAddress(args[5], DST_TOKEN_ADDRESS)).toBe(true);
    });

    it("encodes minDstAmount as i128 at arg[6]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      const expected = nativeToScVal(990_000n, { type: "i128" });
      expect(args[6].toXDR("base64")).toBe(expected.toXDR("base64"));
    });

    it("encodes deadline as u64 at arg[7]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.registerIntent(params);

      const args = getInvokeArgs(stellarTxService);
      const expected = nativeToScVal(1_700_000_000, { type: "u64" });
      expect(args[7].toXDR("base64")).toBe(expected.toXDR("base64"));
    });

    it("returns the result from invokeContract", async () => {
      const { client } = makeClient();
      await expect(client.registerIntent(params)).resolves.toEqual(DRY_RUN_RESULT);
    });

    it("propagates errors thrown by invokeContract", async () => {
      const { client, stellarTxService } = makeClient();
      stellarTxService.invokeContract.mockRejectedValueOnce(new Error("rpc failure"));

      await expect(client.registerIntent(params)).rejects.toThrow("rpc failure");
    });
  });

  // -------------------------------------------------------------------------
  // acceptIntent
  // -------------------------------------------------------------------------
  describe("acceptIntent", () => {
    const params: AcceptIntentParams = {
      intentId: "intent-002",
      solver: SOLVER_ADDRESS,
    };

    it("calls invokeContract with method=accept_intent and the correct contractId", async () => {
      const { client, stellarTxService } = makeClient();
      await client.acceptIntent(params);

      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(CONTRACT_ID);
      expect(call.method).toBe("accept_intent");
    });

    it("encodes intentId as string at arg[0]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.acceptIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsString(args[0], "intent-002")).toBe(true);
    });

    it("encodes solver as an Address ScVal at arg[1]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.acceptIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsAddress(args[1], SOLVER_ADDRESS)).toBe(true);
    });

    it("passes exactly 2 args", async () => {
      const { client, stellarTxService } = makeClient();
      await client.acceptIntent(params);

      expect(getInvokeArgs(stellarTxService)).toHaveLength(2);
    });

    it("propagates errors from invokeContract", async () => {
      const { client, stellarTxService } = makeClient();
      stellarTxService.invokeContract.mockRejectedValueOnce(new Error("network error"));

      await expect(client.acceptIntent(params)).rejects.toThrow("network error");
    });
  });

  // -------------------------------------------------------------------------
  // settleFill
  // -------------------------------------------------------------------------
  describe("settleFill", () => {
    const params: SettleFillParams = {
      intentId: "intent-003",
      solver: SOLVER_ADDRESS,
      fillAmount: 500_000n,
      txHash: "0xdeadbeef",
    };

    it("calls invokeContract with method=settle_fill and the correct contractId", async () => {
      const { client, stellarTxService } = makeClient();
      await client.settleFill(params);

      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(CONTRACT_ID);
      expect(call.method).toBe("settle_fill");
    });

    it("encodes intentId as string at arg[0]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.settleFill(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsString(args[0], "intent-003")).toBe(true);
    });

    it("encodes solver as an Address ScVal at arg[1]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.settleFill(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsAddress(args[1], SOLVER_ADDRESS)).toBe(true);
    });

    it("encodes fillAmount as i128 at arg[2]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.settleFill(params);

      const args = getInvokeArgs(stellarTxService);
      const expected = nativeToScVal(500_000n, { type: "i128" });
      expect(args[2].toXDR("base64")).toBe(expected.toXDR("base64"));
    });

    it("encodes txHash as string at arg[3]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.settleFill(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsString(args[3], "0xdeadbeef")).toBe(true);
    });

    it("passes exactly 4 args", async () => {
      const { client, stellarTxService } = makeClient();
      await client.settleFill(params);

      expect(getInvokeArgs(stellarTxService)).toHaveLength(4);
    });

    it("propagates errors from invokeContract", async () => {
      const { client, stellarTxService } = makeClient();
      stellarTxService.invokeContract.mockRejectedValueOnce(new Error("tx failed"));

      await expect(client.settleFill(params)).rejects.toThrow("tx failed");
    });
  });

  // -------------------------------------------------------------------------
  // cancelIntent
  // -------------------------------------------------------------------------
  describe("cancelIntent", () => {
    const params: CancelIntentParams = {
      intentId: "intent-004",
      user: USER_ADDRESS,
    };

    it("calls invokeContract with method=cancel_intent and the correct contractId", async () => {
      const { client, stellarTxService } = makeClient();
      await client.cancelIntent(params);

      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(CONTRACT_ID);
      expect(call.method).toBe("cancel_intent");
    });

    it("encodes intentId as string at arg[0]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.cancelIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsString(args[0], "intent-004")).toBe(true);
    });

    it("encodes user as an Address ScVal at arg[1]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.cancelIntent(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsAddress(args[1], USER_ADDRESS)).toBe(true);
    });

    it("passes exactly 2 args", async () => {
      const { client, stellarTxService } = makeClient();
      await client.cancelIntent(params);

      expect(getInvokeArgs(stellarTxService)).toHaveLength(2);
    });

    it("propagates errors from invokeContract", async () => {
      const { client, stellarTxService } = makeClient();
      stellarTxService.invokeContract.mockRejectedValueOnce(new Error("cancel failed"));

      await expect(client.cancelIntent(params)).rejects.toThrow("cancel failed");
    });
  });

  // -------------------------------------------------------------------------
  // markExpired
  // -------------------------------------------------------------------------
  describe("markExpired", () => {
    const params: MarkExpiredParams = {
      intentId: "intent-005",
    };

    it("calls invokeContract with method=mark_expired and the correct contractId", async () => {
      const { client, stellarTxService } = makeClient();
      await client.markExpired(params);

      const call = stellarTxService.invokeContract.mock.calls[0][0];
      expect(call.contractId).toBe(CONTRACT_ID);
      expect(call.method).toBe("mark_expired");
    });

    it("encodes intentId as string at arg[0]", async () => {
      const { client, stellarTxService } = makeClient();
      await client.markExpired(params);

      const args = getInvokeArgs(stellarTxService);
      expect(scValIsString(args[0], "intent-005")).toBe(true);
    });

    it("passes exactly 1 arg", async () => {
      const { client, stellarTxService } = makeClient();
      await client.markExpired(params);

      expect(getInvokeArgs(stellarTxService)).toHaveLength(1);
    });

    it("propagates errors from invokeContract", async () => {
      const { client, stellarTxService } = makeClient();
      stellarTxService.invokeContract.mockRejectedValueOnce(new Error("expired error"));

      await expect(client.markExpired(params)).rejects.toThrow("expired error");
    });
  });

  // -------------------------------------------------------------------------
  // contractId sourcing
  // -------------------------------------------------------------------------
  describe("contractId", () => {
    it("reads settlementContractId from config on every call", async () => {
      const { client, stellarTxService, configService } = makeClient();

      await client.markExpired({ intentId: "x" });
      await client.markExpired({ intentId: "y" });

      // configService.get is called once per invokeContract call
      expect(configService.get).toHaveBeenCalledWith("stellar.settlementContractId", { infer: true });
      const calls = stellarTxService.invokeContract.mock.calls;
      expect(calls[0][0].contractId).toBe(CONTRACT_ID);
      expect(calls[1][0].contractId).toBe(CONTRACT_ID);
    });
  });
});
