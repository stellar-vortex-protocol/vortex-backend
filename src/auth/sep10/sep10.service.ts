import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StrKey, Transaction, WebAuth } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type AppConfig } from "../../config/configuration";
import { signEddsaJwt } from "../../common/jwt";
import { SolversService } from "../../solvers/solvers.service";
import { SEP10_ACCOUNT_INFO_LOADER, type Sep10AccountInfo, type Sep10AccountInfoLoader } from "./account-info";
import { SEP10_KEYS, type Sep10KeyMaterial } from "./sep10-keys";
import { SEP10_NONCE_STORE, type Sep10NonceStore } from "./nonce.store";
import { SEP10_JWT_DENYLIST, type Sep10JwtDenylist } from "./jwt-denylist.store";

/** SEP-10 challenge validity window (the protocol's default timeout). */
export const SEP10_CHALLENGE_TIMEOUT_SECONDS = 300;

/**
 * Session JWT lifetime: 15 minutes per issue #442. Refreshing means
 * re-running the challenge flow — there is no refresh token.
 */
export const SEP10_JWT_TTL_SECONDS = 900;

/**
 * Nonce retention: the challenge window plus the 300s clock-drift grace
 * `readChallengeTx` applies to `maxTime`, so a challenge issued at `t` stays
 * exchangeable until `t + 600` but only once.
 */
export const SEP10_NONCE_TTL_SECONDS = SEP10_CHALLENGE_TIMEOUT_SECONDS * 2;

/** Claims carried by the session JWT (issue #442). */
export type Sep10Role = "solver" | "user" | "admin";

/**
 * Claims carried by the session JWT: `sub` (the Stellar account), `role`,
 * `iat`/`exp`, and `jti` — the unique token id used for early revocation
 * (issue #704).
 */
export interface Sep10JwtClaims {
  sub: string;
  role: Sep10Role;
  iat: number;
  exp: number;
  jti: string;
}

/** `GET /api/v1/auth/challenge` response — SEP-10 wire shape. */
export interface Sep10ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

/** `POST /api/v1/auth/token` response: the short-lived session JWT. */
export interface Sep10TokenResponse {
  token: string;
  token_type: "Bearer";
  expires_in: number;
}

/**
 * SEP-10 challenge/verify core (issue #442).
 *
 * `buildChallenge` issues a server-signed challenge transaction (home-domain
 * and `web_auth_domain` manage-data operations, 48-byte nonce, 5-minute time
 * bounds) and remembers its nonce; `exchange` verifies a client-signed
 * challenge against the on-chain account (server signature, time bounds,
 * home domain, client signature weight ≥ threshold), atomically consumes the
 * nonce — so a captured challenge can never yield a second token — and issues
 * a short-lived EdDSA JWT with `sub` and `role`.
 */
@Injectable()
export class Sep10Service {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(SEP10_NONCE_STORE) private readonly nonces: Sep10NonceStore,
    @Inject(SEP10_JWT_DENYLIST) private readonly denylist: Sep10JwtDenylist,
    private readonly solvers: SolversService,
    @Inject(SEP10_KEYS) private readonly keys: Sep10KeyMaterial,
    @Inject(SEP10_ACCOUNT_INFO_LOADER) private readonly accountInfo: Sep10AccountInfoLoader,
  ) {}

  /**
   * Issues a SEP-10 challenge transaction for `account`.
   *
   * The challenge is signed by the server keypair, carries the account as
   * source of the first `manageData` operation (the nonce), and is bound to
   * this deployment's home domain. The nonce is stored immediately so it can
   * only ever be exchanged once.
   */
  async buildChallenge(account: string): Promise<Sep10ChallengeResponse> {
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new BadRequestException("account must be a Stellar G-address");
    }
    const transaction = WebAuth.buildChallengeTx(
      this.keys.challenge,
      account,
      this.homeDomain,
      SEP10_CHALLENGE_TIMEOUT_SECONDS,
      this.networkPassphrase,
      this.homeDomain,
    );
    const nonce = challengeNonce(new Transaction(transaction, this.networkPassphrase));
    await this.nonces.remember(nonce, SEP10_NONCE_TTL_SECONDS);
    return { transaction, network_passphrase: this.networkPassphrase };
  }

  /**
   * Verifies a client-signed challenge and issues the session JWT.
   *
   * Verification order: the server half (signature, sequence, time bounds,
   * home domain, `web_auth_domain`, nonce shape) via the SDK, then the client
   * account's signer weight against its on-chain threshold (multisig-aware),
   * then the single-use nonce. Signatures are checked *before* the nonce is
   * consumed so an attacker cannot burn a legitimate challenge by replaying a
   * malformed exchange.
   */
  async exchange(transaction: string): Promise<Sep10TokenResponse> {
    const read = this.readChallenge(transaction);
    const info = await this.loadAccountInfo(read.clientAccountID);
    try {
      WebAuth.verifyChallengeTxThreshold(
        transaction,
        this.keys.challenge.publicKey(),
        this.networkPassphrase,
        info.threshold,
        info.signers,
        this.homeDomain,
        this.homeDomain,
      );
    } catch (error) {
      throw challengeRejected(error);
    }

    const consumed = await this.nonces.consume(challengeNonce(read.tx));
    if (!consumed) {
      throw new BadRequestException(
        "SEP-10 challenge rejected: nonce was not issued by this server or has already been used (replay)",
      );
    }

    const role = await this.resolveRole(read.clientAccountID);
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims: Sep10JwtClaims = {
      sub: read.clientAccountID,
      role,
      iat: issuedAt,
      exp: issuedAt + SEP10_JWT_TTL_SECONDS,
      jti: randomUUID(),
    };
    const token = signEddsaJwt(claims, this.keys.jwtPrivateKey);
    return { token, token_type: "Bearer", expires_in: SEP10_JWT_TTL_SECONDS };
  }

  /**
   * Revokes a single session JWT (issue #704) by adding its `jti` to the
   * denylist for the token's remaining lifetime — capped at
   * `SEP10_JWT_TTL_SECONDS` so the denylist is self-pruning.
   *
   * The caller is responsible for having verified the token's signature and
   * expiry; this method only records the revocation.
   */
  async revoke(claims: Sep10JwtClaims): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.min(claims.exp - now, SEP10_JWT_TTL_SECONDS);
    if (remaining <= 0) return;
    await this.denylist.revoke(claims.jti, remaining);
  }

  /** Runs the SDK's challenge reader, mapping every failure to a 400. */
  private readChallenge(transaction: string): ReturnType<typeof WebAuth.readChallengeTx> {
    try {
      return WebAuth.readChallengeTx(
        transaction,
        this.keys.challenge.publicKey(),
        this.networkPassphrase,
        this.homeDomain,
        this.homeDomain,
      );
    } catch (error) {
      throw challengeRejected(error);
    }
  }

  /** Loads the client account's signers/threshold; unknown accounts are a 400. */
  private async loadAccountInfo(account: string): Promise<Sep10AccountInfo> {
    try {
      return await this.accountInfo.load(account);
    } catch (error) {
      const status = (error as { response?: { status?: number }; name?: string })?.response?.status;
      if (status === 404 || (error as { name?: string })?.name === "NotFoundError") {
        throw new BadRequestException(
          "SEP-10 challenge rejected: client account does not exist on the network",
        );
      }
      throw error;
    }
  }

  /**
   * Derives the `role` claim: `admin` when the account is listed in
   * `SEP10_ADMIN_ACCOUNTS`, `solver` when the account is registered with the
   * protocol, otherwise `user`.
   */
  private async resolveRole(account: string): Promise<Sep10Role> {
    const admins = this.config
      .get("sep10AdminAccounts", { infer: true })
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (admins.includes(account)) return "admin";
    const solver = await this.solvers.get(account);
    return solver ? "solver" : "user";
  }

  /** The home domain; also used as the challenge's `web_auth_domain` value. */
  private get homeDomain(): string {
    return this.config.get("sep10HomeDomain", { infer: true });
  }

  private get networkPassphrase(): string {
    return NETWORK_PASSPHRASES[this.config.get("stellar.network", { infer: true })];
  }
}

/** Extracts the 48-byte base64 nonce from a challenge's first manageData op. */
function challengeNonce(tx: Transaction): string {
  const op = tx.operations[0];
  if (!op || op.type !== "manageData" || op.value == null) {
    throw new BadRequestException("SEP-10 challenge rejected: missing nonce manageData operation");
  }
  return typeof op.value === "string" ? op.value : Buffer.from(op.value).toString("utf8");
}

/** Maps any SDK challenge-verification failure onto a 400 with its reason. */
function challengeRejected(error: unknown): BadRequestException {
  const reason = error instanceof Error ? error.message : String(error);
  return new BadRequestException(`SEP-10 challenge rejected: ${reason}`);
}
