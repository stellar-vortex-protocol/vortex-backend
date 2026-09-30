import {
  getAddress,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface EvmSigningDomain {
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface EvmIntentFields {
  user: `0x${string}`;
  srcTokenAddress: `0x${string}`;
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

const intentDomain = (domain: EvmSigningDomain) => ({ name: "Vortex", version: "1", ...domain });

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

function bytes32(value: string): Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? (value as Hex) : keccak256(stringToHex(value));
}

function auctionHash(auction: EvmIntentFields["auction"]): Hex {
  const canonical = auction
    ? JSON.stringify(Object.fromEntries(Object.entries(auction).sort(([left], [right]) => left.localeCompare(right))))
    : "null";
  return keccak256(stringToHex(canonical));
}

export async function signEvmCreateIntent(privateKey: Hex, domain: EvmSigningDomain, intent: EvmIntentFields) {
  const account = privateKeyToAccount(privateKey);
  if (getAddress(intent.user) !== account.address) {
    throw new Error("EIP-712 creator address must match the signing account");
  }
  const signature = await account.signTypedData({
    domain: intentDomain(domain),
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
      auctionHash: auctionHash(intent.auction),
      deadline: BigInt(intent.deadline),
      nonce: bytes32(intent.nonce),
      expiresAt: BigInt(intent.expiresAt),
    },
  });
  return { ...intent, user: account.address, signature };
}

export async function signEvmCancelIntent(
  privateKey: Hex,
  domain: EvmSigningDomain,
  intentId: string,
  nonce: string,
  expiresAt: number,
) {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: intentDomain(domain),
    types: cancelIntentTypes,
    primaryType: "CancelIntent",
    message: {
      user: account.address,
      intentId: keccak256(stringToHex(intentId)),
      nonce: bytes32(nonce),
      expiresAt: BigInt(expiresAt),
    },
  });
  return { user: account.address, nonce, expiresAt, signature };
}