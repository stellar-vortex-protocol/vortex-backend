import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  stringToHex,
  type Hex,
} from "viem";
import { AppConfig } from "../config/configuration";
import { EgressPurpose, HttpEgressService } from "./http-egress";

const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const ERC1271_ABI = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);

type EvmChain = keyof AppConfig["evm"]["chains"];

interface CreateIntentPayload {
  user: string;
  srcTokenAddress: string;
  srcTokenSymbol: string;
  srcTokenDecimals: number;
  srcAmount: string;
  dstTokenContract: string;
  dstTokenSymbol: string;
  dstTokenDecimals: number;
  minDstAmount: string;
  auction?: {
    startDstAmount: string;
    decayStart: number;
    decayEnd: number;
    exclusiveSolver?: string;
    exclusivityEnd?: number;
  };
  deadline: number;
  nonce: string;
  expiresAt: number;
}

@Injectable()
export class EvmSignatureVerifier {
  private readonly egress: HttpEgressService;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const evmConfig = config.get("evm", { infer: true });
    this.egress = new HttpEgressService({
      timeoutMs: 10_000,
      maxRedirects: 0,
      maxBodySizeBytes: 16_384,
      allowlist: evmConfig.rpcAllowlist,
      blockPrivateRanges: true,
    });
  }

  async verifyCreateIntent(chain: EvmChain, payload: CreateIntentPayload, signature: string): Promise<void> {
    const chainConfig = this.chainConfig(chain);
    const typedData = {
      domain: { name: "Vortex", version: "1", chainId: chainConfig.chainId, verifyingContract: this.escrow(chainConfig.escrowAddress) },
      types: {
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
      },
      primaryType: "CreateIntent",
      message: {
        user: this.address(payload.user, "creator"),
        srcToken: this.address(payload.srcTokenAddress, "source token"),
        srcTokenSymbol: keccak256(stringToHex(payload.srcTokenSymbol)),
        srcTokenDecimals: payload.srcTokenDecimals,
        srcAmount: BigInt(payload.srcAmount),
        dstTokenContract: keccak256(stringToHex(payload.dstTokenContract)),
        dstTokenSymbol: keccak256(stringToHex(payload.dstTokenSymbol)),
        dstTokenDecimals: payload.dstTokenDecimals,
        minDstAmount: BigInt(payload.minDstAmount),
        auctionHash: payload.auction
          ? keccak256(
              stringToHex(
                JSON.stringify(
                  Object.fromEntries(Object.entries(payload.auction).sort(([left], [right]) => left.localeCompare(right))),
                ),
              ),
            )
          : keccak256(stringToHex("null")),
        deadline: BigInt(payload.deadline),
        nonce: this.nonceBytes32(payload.nonce),
        expiresAt: BigInt(payload.expiresAt),
      },
    } as const;
    await this.verify(chainConfig.rpcUrl, this.address(payload.user, "creator"), signature, typedData);
  }

  async verifyCancelIntent(
    chain: EvmChain,
    user: string,
    intentId: string,
    nonce: string,
    expiresAt: number,
    signature: string,
  ): Promise<void> {
    const chainConfig = this.chainConfig(chain);
    const typedData = {
      domain: { name: "Vortex", version: "1", chainId: chainConfig.chainId, verifyingContract: this.escrow(chainConfig.escrowAddress) },
      types: {
        CancelIntent: [
          { name: "user", type: "address" },
          { name: "intentId", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      primaryType: "CancelIntent",
      message: {
        user: this.address(user, "creator"),
        intentId: keccak256(stringToHex(intentId)),
        nonce: this.nonceBytes32(nonce),
        expiresAt: BigInt(expiresAt),
      },
    } as const;
    await this.verify(chainConfig.rpcUrl, this.address(user, "creator"), signature, typedData);
  }

  private async verify(
    rpcUrl: string,
    signer: `0x${string}`,
    signature: string,
    typedData: Parameters<typeof hashTypedData>[0],
  ): Promise<void> {
    if (!/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(signature)) {
      throw new UnauthorizedException("Invalid EVM signature encoding");
    }
    const hexSignature = signature as Hex;
    try {
      const recovered = await recoverTypedDataAddress({ ...typedData, signature: hexSignature });
      if (recovered.toLowerCase() === signer.toLowerCase()) {
        this.rejectHighS(signature);
        return;
      }
    } catch {
      // ERC-1271 signatures are wallet-defined and may not be recoverable as EOAs.
    }

    const digest = hashTypedData(typedData);
    const data = encodeFunctionData({
      abi: ERC1271_ABI,
      functionName: "isValidSignature",
      args: [digest, hexSignature],
    });
    let response;
    try {
      response = await this.egress.fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: signer, data }, "latest"] }),
        purpose: EgressPurpose.RPC,
      });
    } catch {
      throw new ServiceUnavailableException("EVM signature verification RPC is unavailable");
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ServiceUnavailableException("EVM signature verification RPC returned an error");
    }
    let result: unknown;
    try {
      const decoded = JSON.parse(response.body) as { result?: unknown; error?: unknown };
      if (decoded.error) throw new Error("RPC returned an error");
      result = decoded.result;
    } catch {
      throw new ServiceUnavailableException("EVM signature verification RPC returned an invalid response");
    }
    if (typeof result !== "string" || result.slice(0, 10).toLowerCase() !== ERC1271_MAGIC_VALUE) {
      throw new UnauthorizedException("EVM signature verification failed");
    }
  }

  private rejectHighS(signature: string): void {
    if (signature.length === 132 || signature.length === 130) {
      const rawS = BigInt(`0x${signature.slice(66, 130)}`);
      const s = signature.length === 130 ? rawS & ((1n << 255n) - 1n) : rawS;
      if (s > SECP256K1_HALF_ORDER) throw new UnauthorizedException("High-s EVM signatures are not accepted");
    }
  }

  private nonceBytes32(nonce: string): Hex {
    if (/^0x[0-9a-fA-F]{64}$/.test(nonce)) return nonce as Hex;
    return keccak256(stringToHex(nonce));
  }

  private chainConfig(chain: EvmChain): AppConfig["evm"]["chains"][EvmChain] {
    const value = this.config.get(`evm.chains.${chain}`, { infer: true });
    if (!value.rpcUrl || !value.escrowAddress) {
      throw new ServiceUnavailableException(`EVM signature verification is not configured for ${chain}`);
    }
    const rpcHost = new URL(value.rpcUrl).hostname;
    if (!this.config.get("evm.rpcAllowlist", { infer: true }).some((host) =>
      rpcHost === host || (host.startsWith("*.") && rpcHost.endsWith(host.slice(1))),
    )) {
      throw new ServiceUnavailableException(`EVM RPC host ${rpcHost} is not in EVM_RPC_ALLOWLIST`);
    }
    return value;
  }

  private escrow(address: string): `0x${string}` {
    try {
      return getAddress(address);
    } catch {
      throw new ServiceUnavailableException("EVM escrow verifyingContract is invalid");
    }
  }

  private address(value: string, label: string): `0x${string}` {
    try {
      return getAddress(value);
    } catch {
      throw new BadRequestException(`Invalid EVM ${label} address`);
    }
  }
}