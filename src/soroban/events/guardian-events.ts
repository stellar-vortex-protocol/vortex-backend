import { scValToNative, SorobanRpc } from "@stellar/stellar-sdk";

/** Emergency action categories emitted by the guardian / security council contract. */
export type GuardianActionKind = "pause" | "freeze" | "blacklist";

/** A decoded guardian event: activation (`active: true`) or clearing of an action. */
export interface GuardianEvent {
  /** Soroban event id ("<ledger>-<index>"). */
  id: string;
  kind: GuardianActionKind;
  /** Parameter key for freeze ("*" = all), solver address for blacklist, "" for pause. */
  target: string;
  active: boolean;
  ledger: number;
  txHash: string;
  ledgerClosedAt: string;
}

/**
 * Expected topic layout (issue #507; the contract itself is out of scope):
 *
 *   topic[0] = Symbol event name (table below)
 *   topic[1] = target — String/Symbol/Address; required for freeze/blacklist
 *
 *   guardian_pause        / guardian_unpause        → protocol pause
 *   guardian_freeze       / guardian_unfreeze       → parameter freeze
 *   guardian_blacklist    / guardian_unblacklist    → solver suspension
 */
const EVENT_MAP: Record<string, { kind: GuardianActionKind; active: boolean }> = {
  guardian_pause: { kind: "pause", active: true },
  guardian_unpause: { kind: "pause", active: false },
  guardian_freeze: { kind: "freeze", active: true },
  guardian_unfreeze: { kind: "freeze", active: false },
  guardian_blacklist: { kind: "blacklist", active: true },
  guardian_unblacklist: { kind: "blacklist", active: false },
};

function native(scVal: unknown): unknown {
  try {
    return scValToNative(scVal as Parameters<typeof scValToNative>[0]);
  } catch {
    return undefined;
  }
}

/** Decodes a guardian contract event, or returns null for unrelated / malformed events. */
export function decodeGuardianEvent(event: SorobanRpc.Api.EventResponse): GuardianEvent | null {
  const [name, rawTarget] = event.topic.map(native);
  const mapping = typeof name === "string" ? EVENT_MAP[name] : undefined;
  if (!mapping) return null;

  const target = rawTarget === undefined || rawTarget === null ? "" : String(rawTarget);
  if (mapping.kind !== "pause" && !target) return null;

  return {
    id: event.id,
    kind: mapping.kind,
    target: mapping.kind === "pause" ? "" : target,
    active: mapping.active,
    ledger: event.ledger,
    txHash: event.txHash,
    ledgerClosedAt: event.ledgerClosedAt,
  };
}
