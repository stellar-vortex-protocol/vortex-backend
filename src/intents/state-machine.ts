import { INTENT_STATES, IntentAuditEntry, IntentState } from "./intents.types";

/**
 * Canonical intent lifecycle state machine (issues #471 / #473 / #406).
 *
 * {@link TRANSITION_TABLE} is the single source of truth for every legal
 * state change. Everything else is derived from it:
 *
 * - {@link TRANSITIONS} / {@link canTransition} — the lifecycle view mirrored
 *   by the TLA+ spec in `formal/IntentLifecycle.tla` (see `formal/README.md`).
 * - {@link transition} — the pure planning function every mutating code path
 *   in `IntentsService` calls before it persists a state change. Its plan
 *   carries the audit entry the service writes for that change.
 * - {@link DB_ALLOWED_TRANSITIONS} / {@link renderAllowedPairsSql} — the
 *   `(from, to)` pairs seeded into the `intent_state_transitions` table that
 *   the `intents_enforce_state_transition` Postgres trigger checks on every
 *   `UPDATE` of `intents.state`. `state-machine-sql.spec.ts` fails when the
 *   migration's seed drifts from this table.
 *
 * Edge kinds:
 *
 * - `lifecycle` — the business transitions (`open → accepted`, …).
 * - `park` — the guarded off-chain write has committed and its chain write is
 *   in flight (issue #385). Includes `filled → pending_filled` and
 *   `cancelled → pending_cancelled`: the terminal state is already decided,
 *   the marker only records that the chain has not confirmed it yet.
 * - `confirm` — the chain confirmed the in-flight write; the marker settles
 *   back to its base state.
 * - `compensation` — the slashing saga rolled a slash back (the fill landed
 *   after all, or the slash could not be submitted). These leave a terminal
 *   state, so they need an explicit override: in TypeScript
 *   `ctx.override = true`, in Postgres the transaction-local setting
 *   `vortex.intent_state_override = 'on'`.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> open
 *   [*] --> pending_open
 *   pending_open --> open: confirm
 *   open --> accepted: acceptIfOpen
 *   open --> cancelled: cancelIfOpen
 *   open --> expired: expireIfOpen
 *   accepted --> filled: fillIfAccepted
 *   accepted --> slashed: slashIfAccepted
 *   accepted --> pending_accepted: park
 *   pending_accepted --> accepted: confirm
 *   filled --> pending_filled: park
 *   pending_filled --> filled: confirm
 *   cancelled --> pending_cancelled: park
 *   pending_cancelled --> cancelled: confirm
 *   slashed --> filled: compensation (override)
 *   slashed --> expired: compensation (override)
 * ```
 *
 * Fill-then-slash and slash-then-fill races are both rejected: `filled` and
 * `slashed` have no outgoing lifecycle edges.
 */

/** Category of a {@link TransitionRule}; see the module docs. */
export type TransitionKind = "lifecycle" | "park" | "confirm" | "compensation";

/** Side effects the service applies once a transition has been persisted. */
export type TransitionSideEffect =
  /** `vortex_intent_state_transitions_total{from_state,to_state}`. */
  | "metric"
  /** Row in `intent_audit_log` (plus the in-memory read path). */
  | "audit"
  /** Fill-window job scheduled for the new deadline (issue #550). */
  | "schedule_fill_window"
  /** Shadow-mode comparison against the settlement contract. */
  | "shadow"
  /** Chain broadcast followed by a park in the matching `pending_*` state. */
  | "onchain_broadcast"
  /** Solver penalty rolled back by the slashing saga. */
  | "rollback_penalty";

/** One legal `(from, to)` edge with its guard and side-effect metadata. */
export interface TransitionRule {
  readonly from: IntentState;
  readonly to: IntentState;
  readonly kind: TransitionKind;
  /** Human-readable guard enforced by the persistence layer's conditional write. */
  readonly guard: string;
  /** Effects applied after the write wins, in addition to `metric` + `audit`. */
  readonly sideEffects: readonly TransitionSideEffect[];
  /** Audit reason used when the caller supplies none. */
  readonly defaultReason: string;
}

const ALWAYS: readonly TransitionSideEffect[] = ["metric", "audit"];

function rule(
  from: IntentState,
  to: IntentState,
  kind: TransitionKind,
  guard: string,
  defaultReason: string,
  extra: readonly TransitionSideEffect[] = [],
): TransitionRule {
  return Object.freeze({ from, to, kind, guard, defaultReason, sideEffects: Object.freeze([...ALWAYS, ...extra]) });
}

/**
 * Every legal intent state change. Order is irrelevant; pairs are unique.
 * Adding a row here also requires regenerating the SQL seed — see
 * {@link renderAllowedPairsSql}.
 */
export const TRANSITION_TABLE: readonly TransitionRule[] = Object.freeze([
  // ── lifecycle ──────────────────────────────────────────────────────────────
  rule("open", "accepted", "lifecycle", "state = open AND deadline > now", "solver accepted", [
    "schedule_fill_window",
    "shadow",
    "onchain_broadcast",
  ]),
  rule("open", "cancelled", "lifecycle", "state = open", "user cancelled", ["shadow", "onchain_broadcast"]),
  rule("open", "expired", "lifecycle", "state = open", "deadline passed", ["shadow"]),
  rule("accepted", "filled", "lifecycle", "state = accepted AND solver = caller AND deadline > now", "solver filled", [
    "shadow",
    "onchain_broadcast",
  ]),
  rule("accepted", "slashed", "lifecycle", "state = accepted", "accepted intent not filled before deadline", ["shadow"]),

  // ── park: chain write in flight (issue #385) ───────────────────────────────
  rule("open", "pending_open", "park", "state = open", "create broadcast pending confirmation"),
  rule("open", "pending_accepted", "park", "state = open", "accept broadcast pending confirmation"),
  rule("open", "pending_cancelled", "park", "state = open", "cancel broadcast pending confirmation"),
  rule("accepted", "pending_accepted", "park", "state = accepted", "accept broadcast pending confirmation"),
  rule("accepted", "pending_filled", "park", "state = accepted", "fill broadcast pending confirmation"),
  rule("accepted", "pending_cancelled", "park", "state = accepted", "cancel broadcast pending confirmation"),
  rule("filled", "pending_filled", "park", "state = filled", "fill broadcast pending confirmation"),
  rule("cancelled", "pending_cancelled", "park", "state = cancelled", "cancel broadcast pending confirmation"),

  // ── confirm: chain observed the write ──────────────────────────────────────
  rule("pending_open", "open", "confirm", "state = pending_open", "create confirmed on-chain"),
  rule("pending_accepted", "accepted", "confirm", "state = pending_accepted", "accept confirmed on-chain"),
  rule("pending_filled", "filled", "confirm", "state = pending_filled", "fill confirmed on-chain"),
  rule("pending_cancelled", "cancelled", "confirm", "state = pending_cancelled", "cancel confirmed on-chain"),

  // ── compensation: slashing saga rollback (override required) ───────────────
  rule("slashed", "filled", "compensation", "state = slashed AND override", "slash cancelled: fill_landed", [
    "rollback_penalty",
  ]),
  rule("slashed", "expired", "compensation", "state = slashed AND override", "slash cancelled", ["rollback_penalty"]),
]);

const RULE_INDEX: ReadonlyMap<string, TransitionRule> = new Map(
  TRANSITION_TABLE.map((r) => [`${r.from}->${r.to}`, r]),
);

/** Look up the rule for `from → to`, if one exists. */
export function findRule(from: IntentState, to: IntentState): TransitionRule | undefined {
  return RULE_INDEX.get(`${from}->${to}`);
}

/** True when `rule` needs an explicit override to be applied. */
export function requiresOverride(r: TransitionRule): boolean {
  return r.kind === "compensation";
}

/** States from which no lifecycle transition is legal. */
export const TERMINAL_STATES: readonly IntentState[] = ["filled", "cancelled", "expired", "slashed"];

/**
 * True when `state` is terminal (no outgoing lifecycle edges).
 */
export function isTerminalState(state: IntentState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Lifecycle view of {@link TRANSITION_TABLE}: every edge except compensations
 * and parks out of terminal states. Terminal states therefore stay sinks,
 * which is what the TLA+ spec models.
 */
export const TRANSITIONS: Readonly<Record<IntentState, readonly IntentState[]>> = Object.freeze(
  Object.fromEntries(
    INTENT_STATES.map((from) => [
      from,
      Object.freeze(
        TRANSITION_TABLE.filter(
          (r) => r.from === from && !requiresOverride(r) && !isTerminalState(r.from),
        ).map((r) => r.to),
      ),
    ]),
  ) as Record<IntentState, readonly IntentState[]>,
);

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
 * Assert `from → to` is a legal lifecycle step, throwing a descriptive
 * `Error` otherwise. Useful as a fast-path guard before attempting a
 * conditional repository write.
 */
export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal intent transition: ${from} → ${to}`);
  }
}

/** Who caused a transition and why — becomes the audit entry. */
export interface TransitionContext {
  /** User address, solver address, `"system"`, `"reconciler"`, … */
  actor: string;
  /** Overrides {@link TransitionRule.defaultReason}. */
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Required for `compensation` edges; ignored otherwise. */
  override?: boolean;
  /** Clock for the audit timestamp; defaults to now. */
  at?: Date;
}

/** Result of {@link transition}: what the persistence layer must apply. */
export interface TransitionPlan {
  readonly intentId: string;
  readonly from: IntentState;
  readonly to: IntentState;
  readonly rule: TransitionRule;
  /** Audit entry to write once the change has been persisted. */
  readonly audit: IntentAuditEntry;
}

/** Thrown by {@link transition} for an edge that is absent or not permitted. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly intentId: string,
    readonly from: IntentState,
    readonly to: IntentState,
    detail: string,
  ) {
    super(`Illegal intent transition for ${intentId}: ${from} → ${to} (${detail})`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Plan the move of `intent` into `to`. Pure: it reads the table, validates the
 * edge and builds the audit entry, but writes nothing. The caller persists the
 * change with a conditional write on `state = plan.from` and, if that write
 * wins, applies the plan's side effects.
 *
 * @throws {@link IllegalTransitionError} when the edge does not exist, or is a
 *   compensation edge and `ctx.override` is not set.
 */
export function transition(
  intent: { intentId: string; state: IntentState },
  to: IntentState,
  ctx: TransitionContext,
): TransitionPlan {
  const from = intent.state;
  const found = findRule(from, to);
  if (!found) {
    throw new IllegalTransitionError(intent.intentId, from, to, "no such edge");
  }
  if (requiresOverride(found) && ctx.override !== true) {
    throw new IllegalTransitionError(intent.intentId, from, to, `${found.kind} edge requires an override`);
  }
  return {
    intentId: intent.intentId,
    from,
    to,
    rule: found,
    audit: {
      timestamp: (ctx.at ?? new Date()).toISOString(),
      toState: to,
      actor: ctx.actor,
      reason: ctx.reason ?? found.defaultReason,
      metadata: { ...(ctx.metadata ?? {}), fromState: from },
    },
  };
}

/** Pairs the Postgres trigger accepts without an override (all but compensations). */
export const DB_ALLOWED_TRANSITIONS: readonly TransitionRule[] = Object.freeze(
  TRANSITION_TABLE.filter((r) => !requiresOverride(r)),
);

/** Marker comments delimiting the generated seed inside the migration. */
export const SQL_SEED_BEGIN = "-- BEGIN GENERATED: intent_state_transitions (src/intents/state-machine.ts)";
export const SQL_SEED_END = "-- END GENERATED: intent_state_transitions";

/**
 * Render the `INSERT` that seeds `intent_state_transitions` from
 * {@link DB_ALLOWED_TRANSITIONS}, sorted for a stable diff. The migration
 * embeds this text between {@link SQL_SEED_BEGIN} and {@link SQL_SEED_END};
 * `npm run check:state-machine` regenerates and compares it.
 */
export function renderAllowedPairsSql(): string {
  const order = (s: IntentState) => INTENT_STATES.indexOf(s);
  const rows = [...DB_ALLOWED_TRANSITIONS]
    .sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to))
    .map((r) => `  ('${r.from}', '${r.to}', '${r.kind}')`);
  return [
    SQL_SEED_BEGIN,
    `INSERT INTO "intent_state_transitions" ("from_state", "to_state", "kind") VALUES`,
    rows.join(",\n"),
    `ON CONFLICT DO NOTHING;`,
    SQL_SEED_END,
  ].join("\n");
}
