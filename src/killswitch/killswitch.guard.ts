import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { KILL_SWITCH_GUARD, KillSwitchGuardMetadata } from "./killswitch.guard.token";
import { KillSwitchService } from "./killswitch.service";
import { KillSwitchOperation, SwitchTarget } from "./killswitch.types";

/** 503 + Retry-After: clients are told when it is worth retrying, and why not now. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;

export class KillSwitchActiveException extends HttpException {
  /**
   * Read by the global exception filter to emit the `Retry-After` header. Kept
   * off the JSON body so the response shape stays clean.
   */
  readonly retryAfterSeconds: number;

  /** Denormalised so callers can log or branch without re-parsing the body. */
  readonly reasonCode: string;
  readonly reason: string;
  readonly scope: string;
  readonly chain: string | null;
  readonly token: string | null;
  readonly operation: string | null;

  constructor(payload: {
    reasonCode: string;
    reason: string;
    scope: string;
    chain: string | null;
    token: string | null;
    operation: string | null;
    activatedBy: string;
    since: number;
    retryAfterSeconds: number;
  }) {
    super(
      {
        error: "Killswitch active",
        reason: payload.reasonCode,
        message: payload.reason,
        scope: payload.scope,
        chain: payload.chain,
        token: payload.token,
        operation: payload.operation,
        activatedBy: payload.activatedBy,
        since: payload.since,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.retryAfterSeconds = payload.retryAfterSeconds;
    this.reasonCode = payload.reasonCode;
    this.reason = payload.reason;
    this.scope = payload.scope;
    this.chain = payload.chain;
    this.token = payload.token;
    this.operation = payload.operation;
  }
}

/**
 * Route decorator: gate an endpoint on the kill-switch hierarchy.
 *
 *   \@UseGuards(KillSwitchGuard)
 *   \@KillSwitchGate({ operation: "fill", chain: "stellar" })
 *
 * `chain` and `token` may be omitted, in which case they are taken from the
 * request body/query at runtime — that is what lets a single guard cover every
 * intent write without each handler restating its own address.
 */
export const KillSwitchGate = (metadata: KillSwitchGuardMetadata) =>
  SetMetadata(KILL_SWITCH_GUARD, metadata);

interface BodyWithAddress {
  srcChain?: string;
  dstChain?: string;
  chain?: string;
  token?: string;
  address?: string;
  srcTokenAddress?: string;
  srcToken?: { address?: string; symbol?: string } | string;
  dstToken?: { address?: string; symbol?: string } | string;
}

function readAddress(body: BodyWithAddress, params: Record<string, string>): SwitchTarget {
  const chain =
    params.chain ?? body.chain ?? body.srcChain ?? body.dstChain ?? null;

  const rawToken =
    body.token ??
    body.srcTokenAddress ??
    body.srcToken ??
    body.dstToken ??
    body.address ??
    params.token;
  const token =
    typeof rawToken === "string" ? rawToken : (rawToken?.address ?? rawToken?.symbol ?? null);

  return { chain, token };
}

/**
 * Turn a decision into the 503 the client sees, or return normally.
 *
 * Lives here rather than in the guard so that handlers which can only learn
 * their chain/token *after* loading a record (accept, fill) can re-use exactly
 * the same evaluation and error shape instead of re-implementing the mapping.
 */
export function assertNotPaused(
  killSwitch: Pick<KillSwitchService, "evaluateTarget">,
  target: SwitchTarget & { operation: KillSwitchOperation },
  options: { retryAfterSeconds?: number } = {},
): void {
  const decision = killSwitch.evaluateTarget(target);
  if (!decision.paused) return;

  const match = decision.matched;
  throw new KillSwitchActiveException({
    reasonCode: match?.reasonCode ?? "UNKNOWN",
    reason: match?.reason ?? "An emergency pause is active for this scope",
    scope: match?.scope ?? "global",
    chain: match?.chain ?? null,
    token: match?.token ?? null,
    operation: match?.operation ?? target.operation,
    activatedBy: match?.activatedBy ?? "unknown",
    since: match?.updatedAt ?? Date.now(),
    retryAfterSeconds: options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
  });
}

/**
 * Blocks a write when any matching switch is active.
 *
 * Fails closed: if the service has not loaded its snapshot, the request is
 * refused rather than admitted.
 */
@Injectable()
export class KillSwitchGuard implements CanActivate {
  constructor(
    private readonly killSwitch: KillSwitchService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const metadata = this.reflector.getAllAndOverride<KillSwitchGuardMetadata | undefined>(
      KILL_SWITCH_GUARD,
      [context.getHandler(), context.getClass()],
    );
    if (!metadata) return true;

    const operation = metadata.operation as KillSwitchOperation;
    const request = context.switchToHttp().getRequest<{
      body: BodyWithAddress;
      params: Record<string, string>;
    }>();

    const address = readAddress(request.body ?? {}, request.params ?? {});
    // An explicit value in the decorator wins over the request-derived one.
    const target: SwitchTarget & { operation: KillSwitchOperation } = {
      chain: metadata.chain ?? address.chain ?? null,
      token: metadata.token ?? address.token ?? null,
      operation,
    };

    assertNotPaused(this.killSwitch, target, {
      retryAfterSeconds: metadata.retryAfterSeconds,
    });
    return true;
  }
}
