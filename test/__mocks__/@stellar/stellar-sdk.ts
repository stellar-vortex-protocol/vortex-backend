/**
 * Hermetic test double for `@stellar/stellar-sdk`.
 *
 * The e2e suite must not talk to a real Soroban RPC node, but it *does* need
 * the genuine SDK for everything that is pure computation: Ed25519 keypairs
 * and signature verification (`Keypair`, `verifyStellarSignature`), Stellar
 * strkey encode/decode (`StrKey`, `Address`), XDR marshalling (`xdr`,
 * `nativeToScVal`, `scValToNative`) and transaction assembly
 * (`TransactionBuilder`, `Contract`). Re-implementing those by hand would let
 * tests pass against a fake crypto path that production never uses.
 *
 * So this mock re-exports the real module and replaces *only* the network
 * layer — `SorobanRpc.Server` — with an in-memory stub.
 *
 * Resolution note: jest maps the bare specifier `@stellar/stellar-sdk` to this
 * file, so requiring the bare specifier here would recurse forever. The real
 * module is therefore loaded by filesystem path, which the
 * `moduleNameMapper` regex (`^@stellar/stellar-sdk$`, anchored) does not match.
 * A `require`-based load also sidesteps the package's `exports` gate, which
 * only permits `.`, `./contract`, and `./rpc`.
 */

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const real: any = require(
  // __dirname is <root>/test/__mocks__/@stellar, so the repo root is two levels
  // up ("../..") — three levels overshoots the repo and makes `real` undefined,
  // which surfaces far away as "Cannot read properties of undefined (reading
  // 'Server')" inside every e2e suite that boots the Nest app.
  path.join(__dirname, "..", "..", "..", "node_modules", "@stellar", "stellar-sdk", "lib", "index.js"),
);

const mockServer = {
  getHealth: jest.fn().mockResolvedValue({ status: "ok" }),
  getLatestLedger: jest.fn().mockResolvedValue({ sequence: 1 }),
  getNetwork: jest.fn().mockResolvedValue({ passphrase: "test" }),
  getAccount: jest.fn().mockResolvedValue({ id: "test", sequenceNumber: () => "0" }),
  getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 1 }),
  getFeeStats: jest.fn().mockResolvedValue({
    sorobanInclusionFee: {
      min: "100",
      mode: "100",
      p10: "100",
      p20: "100",
      p30: "100",
      p40: "100",
      p50: "100",
      p60: "100",
      p70: "100",
      p80: "100",
      p90: "100",
      p95: "100",
      p99: "100",
      max: "100",
    },
  }),
  simulateTransaction: jest.fn().mockResolvedValue({ minResourceFee: "100" }),
  prepareTransaction: jest.fn().mockImplementation((tx: unknown) => tx),
  sendTransaction: jest.fn().mockResolvedValue({ status: "SUCCESS", hash: "mock-hash" }),
};

const mockServerClass = jest.fn().mockImplementation(() => mockServer);

/**
 * Network stub. `Api` is spread from the real module so type guards such as
 * `SorobanRpc.Api.isSimulationError` keep working exactly as in production.
 */
export const SorobanRpc = {
  ...real.SorobanRpc,
  Server: mockServerClass,
  Api: {
    ...real.SorobanRpc?.Api,
    isSimulationError: (response: unknown): boolean =>
      Boolean(
        response &&
          typeof response === "object" &&
          "error" in (response as Record<string, unknown>) &&
          (response as Record<string, unknown>).error != null,
      ),
  },
};

// ── Genuine SDK re-exports ───────────────────────────────────────────────────
// Everything below is the real implementation, re-exported explicitly rather
// than via `export *` so that the star-export does not shadow the stubbed
// `SorobanRpc` above and so each name is individually type-checked.

export const Keypair = real.Keypair;
export const Networks = real.Networks;
export const StrKey = real.StrKey;
export const Address = real.Address;
export const Asset = real.Asset;
export const Horizon = real.Horizon;
export const Contract = real.Contract;
export const Account = real.Account;
export const Operation = real.Operation;
export const Transaction = real.Transaction;
export const FeeBumpTransaction = real.FeeBumpTransaction;
export const TransactionBuilder = real.TransactionBuilder;
export const xdr = real.xdr;
export const nativeToScVal = real.nativeToScVal;
export const scValToNative = real.scValToNative;
export const BASE_FEE = real.BASE_FEE;
// Namespaced clients used by production code (e.g. TreasuryService builds
// `new StellarSdk.Horizon.Server(...)`). Without these the mock leaves
// `StellarSdk.Horizon` undefined and every e2e suite that boots the app fails.
export const Horizon = real.Horizon;
export const Utils = real.Utils;
export const Config = real.Config;
export const MuxedAccount = real.MuxedAccount;
export const hash = real.hash;
export const Memo = real.Memo;
export const Timepoint = real.Timepoint;
export const SorobanDataBuilder = real.SorobanDataBuilder;
export const authorizeEntry = real.authorizeEntry;
export const decodeAddressToScVal = real.decodeAddressToScVal;
export const encodeAddressToScVal = real.encodeAddressToScVal;
