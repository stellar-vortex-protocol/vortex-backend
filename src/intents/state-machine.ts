import { IntentState } from "./intents.types";

/**
 * Canonical intent lifecycle transition table (issues #471 / #473).
 *
 * Single source of truth for every legal state change. The TLA+ spec in
 * `formal/IntentLifecycle.tla` mirrors this table exactly — see
 * `formal/README.md` for the action-by-action mapping. All services and
 * repositories must route mutations through {@link canTransition} (or one of
 * the guarded `*If*` repository methods) instead of blind `update()` writes.
 *
 * ```
 *            ┌──────┐  acceptIfOpen   ┌──────────┐  fillIfAccepted  ┌────────┐
 *            │ open ├────────────────►│ accepted ├────────────────►│ filled │ (terminal)
 *            └──┬───┘                 └────┬─────┘                 └────────┘
 *               │ cancelIfOpen              │ slashIfAccepted
 *               ▼                           ▼
 *        ┌───────────┐               ┌─────────┐
 *        │ cancelled │ (terminal)    │ slashed │ (terminal)
 *        └───────────┘               └─────────┘
 *               │
 *               │ expireIfOpen
 *               ▼
 *        ┌─────────┐
 *        │ expired │ (terminal)
 *        └─────────┘
 * ```
 *
 * Fill-then-slash and slash-then-fill are both rejected: `filled` and
 * `slashed` are terminal and have no outgoing edges.
 */
export const TRANSITIONS: Readonly<Record<IntentState, readonly IntentState[]>> = {
  open: ["accepted", "cancelled", "expired"],
  accepted: ["filled", "slashed"],
  filled: [],
  cancelled: [],
  expired: [],
  slashed: [],
};

/** States from which no further transition is legal. */
export const TERMINAL_STATES: readonly IntentState[] = [
  "filled",
  "cancelled",
  "expired",
  "slashed",
];

/**
 * Return true when `from → to` is a legal lifecycle step.
 *
 * @example
 * ```ts
 * canTransition("open", "accepted"); // true
 * canTransition("filled", "slashed"); // false — terminal states are sinks
 * ```
 */
export function canTransition(from: IntentState, to: IntentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Assert `from → to` is legal, throwing a descriptive `Error` otherwise.
 * Useful as a fast-path guard before attempting a conditional repository write.
 */
export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal intent transition: ${from} → ${to}`);
  }
}

/**
 * True when `state` is terminal (no outgoing edges).
 */
export function isTerminalState(state: IntentState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}
