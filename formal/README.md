# Formal verification — intent lifecycle (issue #471)

TLA+ model of the intent lifecycle with concurrent HTTP actions, sweeper,
event ingestion (loss + retry), and on-chain fill confirmation.

## Files

- `IntentLifecycle.tla` — spec (states, pending txs, confirmation delays, event loss, retries).
- `IntentLifecycle.cfg` — bounded TLC model (2 intents, 2 solvers, small constants).

## Mapping to TypeScript

| TLA+ action | TS implementation |
|---|---|
| `Accept` | `IntentsService.acceptIfOpen` + `PrismaIntentsRepository.acceptIfOpen` (`WHERE state=open AND deadline > now`) |
| `Cancel` | `cancelIfOpen` (`WHERE state=open`) |
| `SweeperExpire` | `IntentsSweeperService.sweep` expire pass + `expireIfOpen` |
| `SubmitFill` | `fillIfAccepted` pending-tx submit (`fill >= minDst`, `deadline > now`, at most one pending) |
| `ConfirmFill` | on-chain confirmation resolving pending tx to `filled` |
| `FailTx` / retry | tx failure clears `pendingTx`, fill may be resubmitted |
| `SweeperSlash` | sweeper slash pass + `slashIfAccepted` (`WHERE state=accepted`, fill wins on race) |
| `Tick` | wall-clock advance toward `deadline` |

Canonical transition table: `src/intents/state-machine.ts` (`TRANSITIONS`,
`canTransition`). Any change to that table must update this spec and vice versa.

## Invariants (safety)

- No double terminal state — terminal states are sinks.
- No slash of a filled intent (`filled` has no outgoing edge to `slashed`).
- `fill >= minDst` on every `filled` intent.
- At most one pending tx per intent; pending tx only while `accepted`.

## Liveness

Every intent eventually reaches a terminal state under weak fairness on `Next`.

## Running TLC

```bash
# Docker (no local install):
docker run --rm -v "$PWD/formal:/model" tlaplus/tlaplus \
  tlc -config /model/IntentLifecycle.cfg /model/IntentLifecycle.tla
```

Bounded model (CI): 2 intents (symmetry set), 2 solvers, `MaxDeadline=3`,
`MaxAmount=2`. Keeps the state space tractable.

## Findings log

- Initial model confirmed the fill-vs-slash race: without the `pendingTx=0`
  guard on `SweeperSlash`, TLC finds `accepted --fill-submit--> pending=1
  --slash--> slashed` followed by `ConfirmFill` on a slashed intent. Fix:
  sweeper slash requires no in-flight tx; confirmation requires `accepted`.
  Regression test: `src/intents/state-machine.spec.ts` ("fill confirms after
  sweeper slashes").
- Deadline predicates (`deadline > clock` on accept/submit) are load-bearing:
  removing either yields an accept/fill past expiry trace. Matches the #473
  SQL predicates (`deadline > now`).
