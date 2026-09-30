import { KillSwitchOperation, KillSwitchScope } from "./killswitch.types";

/** Injection/metadata key for {@link KillSwitchGate}. */
export const KILL_SWITCH_GUARD = "killswitch:gate";

/** What a guarded route tells the guard to check. */
export interface KillSwitchGuardMetadata {
  /** The operation this endpoint performs. Required. */
  operation: KillSwitchOperation;
  /**
   * Fixed chain for the route. When omitted the chain is read from the request
   * body/params, which is what lets one decorator cover all intent writes.
   */
  chain?: string | null;
  /** Fixed token, same resolution rules as `chain`. */
  token?: string | null;
  /** Overrides the default 30 s `Retry-After` on the 503. */
  retryAfterSeconds?: number;
}
