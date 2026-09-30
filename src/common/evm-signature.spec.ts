import { ConfigService } from "@nestjs/config";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex } from "viem";
import { AppConfig } from "../config/configuration";
import { HttpEgressService } from "./http-egress";
import { EvmSignatureVerifier } from "./evm-signature";

const privateKey = `0x${"11".repeat(32)}` as `0x${string}`;
const account = privateKeyToAccount(privateKey);
const domain = { chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000001" as const };
const intent = {
  user: account.address,
  srcTokenAddress: "0x0000000000000000000000000000000000000002" as const,
  srcTokenSymbol: "USDC",
  srcTokenDecimals: 6,
  srcAmount: "1000000",
  dstTokenContract: "CDLZFC3SYJYDZT7K67CG2ZMSVXTXRUWDCQ3NDADYQV67QX2PVJ6C6S6D",
  dstTokenSymbol: "USDC",
  dstTokenDecimals: 6,
  minDstAmount: "999000",
  deadline: 1_900_000_000,
  nonce: "0123456789abcdef0123456789abcdef",
  expiresAt: 1_900_000_300,
};

const createIntentTypes = {
  CreateIntent: [
    { name: "user", type: "address" },
    { name: "srcToken", type: "address" },
    { name: "srcTokenSymbol", type: "bytes32" },
    { name: "srcTokenDecimals", type: "uint8" },
    { name: "srcAmount", type: "uint256" },
    { name: "dstTokenContract", type: "bytes32" },
    { name: "dstTokenSymbol", type: "bytes32" },
    { name: "dstTokenDecimals", type: "uint8" },
    { name: "minDstAmount", type: "uint256" },
    { name: "auctionHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
const cancelIntentTypes = {
  CancelIntent: [
    { name: "user", type: "address" },
    { name: "intentId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

async function signCreateIntent() {
  return account.signTypedData({
    domain: { name: "Vortex", version: "1", ...domain },
    types: createIntentTypes,
    primaryType: "CreateIntent",
    message: {
      user: intent.user,
      srcToken: intent.srcTokenAddress,
      srcTokenSymbol: keccak256(stringToHex(intent.srcTokenSymbol)),
      srcTokenDecimals: intent.srcTokenDecimals,
      srcAmount: BigInt(intent.srcAmount),
      dstTokenContract: keccak256(stringToHex(intent.dstTokenContract)),
      dstTokenSymbol: keccak256(stringToHex(intent.dstTokenSymbol)),
      dstTokenDecimals: intent.dstTokenDecimals,
      minDstAmount: BigInt(intent.minDstAmount),
      auctionHash: keccak256(stringToHex("null")),
      deadline: BigInt(intent.deadline),
      nonce: keccak256(stringToHex(intent.nonce)),
      expiresAt: BigInt(intent.expiresAt),
    },
  });
}

async function signCancelIntent(intentId: string) {
  return account.signTypedData({
    domain: { name: "Vortex", version: "1", ...domain },
    types: cancelIntentTypes,
    primaryType: "CancelIntent",
    message: {
      user: account.address,
      intentId: keccak256(stringToHex(intentId)),
      nonce: keccak256(stringToHex(intent.nonce)),
      expiresAt: BigInt(intent.expiresAt),
    },
  });
}

function makeVerifier() {
  const settings = {
    rpcAllowlist: ["rpc.example.com"],
    chains: {
      ethereum: { chainId: 1, rpcUrl: "https://rpc.example.com", escrowAddress: domain.verifyingContract },
      base: { chainId: 8453, rpcUrl: "", escrowAddress: "" },
      polygon: { chainId: 137, rpcUrl: "", escrowAddress: "" },
      arbitrum: { chainId: 42161, rpcUrl: "", escrowAddress: "" },
      optimism: { chainId: 10, rpcUrl: "", escrowAddress: "" },
      avalanche: { chainId: 43114, rpcUrl: "", escrowAddress: "" },
    },
  };
  const config = { get: (key: string) => key === "evm" ? settings : key === "evm.rpcAllowlist" ? settings.rpcAllowlist : settings.chains.ethereum };
  return new EvmSignatureVerifier(config as unknown as ConfigService<AppConfig, true>);
}

describe("EvmSignatureVerifier", () => {
  it("recovers EOA CreateIntent signatures using the configured chain domain", async () => {
    const verifier = makeVerifier();
    const signature = await signCreateIntent();

    await expect(verifier.verifyCreateIntent("ethereum", intent, signature)).resolves.toBeUndefined();
  });

  it("verifies CancelIntent signatures and rejects high-s signatures", async () => {
    const verifier = makeVerifier();
    const signature = await signCancelIntent("intent-1");
    await expect(
      verifier.verifyCancelIntent("ethereum", account.address, "intent-1", intent.nonce, intent.expiresAt, signature),
    ).resolves.toBeUndefined();

    const fetch = jest.spyOn(HttpEgressService.prototype, "fetch").mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }),
      bodyBytes: 32,
      finalUrl: "https://rpc.example.com",
      ipUsed: "203.0.113.1",
    });
    const highS = `0x${signature.slice(2, 66)}${"f".repeat(64)}${signature.slice(-2)}`;
    await expect(
      verifier.verifyCancelIntent("ethereum", account.address, "intent-1", intent.nonce, intent.expiresAt, highS),
    ).rejects.toThrow("EVM signature verification failed");
    fetch.mockRestore();
  });

  it("accepts ERC-1271 magic values through the guarded RPC path", async () => {
    const fetch = jest.spyOn(HttpEgressService.prototype, "fetch").mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1626ba7e" }),
      bodyBytes: 32,
      finalUrl: "https://rpc.example.com",
      ipUsed: "203.0.113.1",
    });
    const verifier = makeVerifier();
    const signature = await signCancelIntent("intent-1");
    const contractWallet = "0x0000000000000000000000000000000000000003";

    await expect(
      verifier.verifyCancelIntent("ethereum", contractWallet, "intent-1", intent.nonce, intent.expiresAt, signature),
    ).resolves.toBeUndefined();
    await expect(
      verifier.verifyCancelIntent("ethereum", contractWallet, "intent-1", intent.nonce, intent.expiresAt, "0x01"),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://rpc.example.com",
      expect.objectContaining({ purpose: "rpc", method: "POST" }),
    );
    fetch.mockRestore();
  });

  it("fails closed when ERC-1271 RPC is unavailable", async () => {
    const fetch = jest.spyOn(HttpEgressService.prototype, "fetch").mockRejectedValue(new Error("offline"));
    const verifier = makeVerifier();
    const signature = await signCancelIntent("intent-1");

    await expect(
      verifier.verifyCancelIntent(
        "ethereum",
        "0x0000000000000000000000000000000000000003",
        "intent-1",
        intent.nonce,
        intent.expiresAt,
        signature,
      ),
    ).rejects.toThrow("RPC is unavailable");
    fetch.mockRestore();
  });
});