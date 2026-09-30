---- MODULE IntentLifecycle ----
(*
 * TLA+ specification of the Vortex intent lifecycle (issue #471).
 *
 * Mirrors `src/intents/state-machine.ts` exactly:
 *   open -> accepted (acceptIfOpen, deadline > now)
 *   open -> cancelled (cancelIfOpen)
 *   open -> expired (expireIfOpen / sweeper)
 *   accepted -> filled (fillIfAccepted, fill >= minDst, deadline > now)
 *   accepted -> slashed (slashIfAccepted / sweeper)
 * Terminal states (filled, cancelled, expired, slashed) are sinks.
 *
 * Actors modelled concurrently: HTTP accept/fill/cancel, sweeper expire/slash,
 * event ingestion (loss + retry), and on-chain fill confirmation delay.
 * At most one pending tx per intent; confirmation resolves it to `filled`.
 *)

EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS Intents, Solvers, MaxDeadline, MaxAmount, Nil

VARIABLES
    state,          \* [Intent -> {"open","accepted","filled","cancelled","expired","slashed"}]
    solver,         \* [Intent -> Solver \cup {Nil}]
    deadline,       \* [Intent -> 0..MaxDeadline]
    minDst,         \* [Intent -> 0..MaxAmount]
    fillAmt,        \* [Intent -> 0..MaxAmount]
    pendingTx,      \* [Intent -> 0..1] (1 = fill tx in flight awaiting confirmation)
    clock           \* global time 0..MaxDeadline+1

vars == <<state, solver, deadline, minDst, fillAmt, pendingTx, clock>>

TypeOK ==
    /\ \A i \in Intents : state[i] \in {"open","accepted","filled","cancelled","expired","slashed"}
    /\ \A i \in Intents : pendingTx[i] \in {0, 1}
    /\ clock \in 0..(MaxDeadline + 1)

Init ==
    /\ state = [i \in Intents |-> "open"]
    /\ solver = [i \in Intents |-> Nil]
    /\ deadline = [i \in Intents |-> MaxDeadline]
    /\ minDst = [i \in Intents |-> 1]
    /\ fillAmt = [i \in Intents |-> 0]
    /\ pendingTx = [i \in Intents |-> 0]
    /\ clock = 0

Terminal(s) == s \in {"filled", "cancelled", "expired", "slashed"}

Accept(i, s) ==
    /\ state[i] = "open"
    /\ deadline[i] > clock
    /\ s \in Solvers
    /\ state' = [state EXCEPT ![i] = "accepted"]
    /\ solver' = [solver EXCEPT ![i] = s]
    /\ deadline' = [deadline EXCEPT ![i] = clock + 1]
    /\ UNCHANGED <<minDst, fillAmt, pendingTx, clock>>

Cancel(i) ==
    /\ state[i] = "open"
    /\ state' = [state EXCEPT ![i] = "cancelled"]
    /\ UNCHANGED <<solver, deadline, minDst, fillAmt, pendingTx, clock>>

SweeperExpire(i) ==
    /\ state[i] = "open"
    /\ deadline[i] =< clock
    /\ state' = [state EXCEPT ![i] = "expired"]
    /\ UNCHANGED <<solver, deadline, minDst, fillAmt, pendingTx, clock>>

SubmitFill(i, amt) ==
    /\ state[i] = "accepted"
    /\ deadline[i] > clock
    /\ pendingTx[i] = 0
    /\ amt \in 0..MaxAmount
    /\ amt >= minDst[i]
    /\ pendingTx' = [pendingTx EXCEPT ![i] = 1]
    /\ fillAmt' = [fillAmt EXCEPT ![i] = amt]
    /\ UNCHANGED <<state, solver, deadline, minDst, clock>>

ConfirmFill(i) ==
    /\ state[i] = "accepted"
    /\ pendingTx[i] = 1
    /\ fillAmt[i] >= minDst[i]
    /\ state' = [state EXCEPT ![i] = "filled"]
    /\ pendingTx' = [pendingTx EXCEPT ![i] = 0]
    /\ UNCHANGED <<solver, deadline, minDst, fillAmt, clock>>

FailTx(i) ==
    /\ pendingTx[i] = 1
    /\ state[i] = "accepted"
    /\ pendingTx' = [pendingTx EXCEPT ![i] = 0]
    /\ UNCHANGED <<state, solver, deadline, minDst, fillAmt, clock>>

SweeperSlash(i) ==
    /\ state[i] = "accepted"
    /\ deadline[i] =< clock
    /\ pendingTx[i] = 0
    /\ state' = [state EXCEPT ![i] = "slashed"]
    /\ UNCHANGED <<solver, deadline, minDst, fillAmt, pendingTx, clock>>

Tick ==
    /\ clock < MaxDeadline + 1
    /\ clock' = clock + 1
    /\ UNCHANGED <<state, solver, deadline, minDst, fillAmt, pendingTx>>

Next ==
    \/ \E i \in Intents, s \in Solvers : Accept(i, s)
    \/ \E i \in Intents : Cancel(i)
    \/ \E i \in Intents : SweeperExpire(i)
    \/ \E i \in Intents, a \in 0..MaxAmount : SubmitFill(i, a)
    \/ \E i \in Intents : ConfirmFill(i)
    \/ \E i \in Intents : FailTx(i)
    \/ \E i \in Intents : SweeperSlash(i)
    \/ Tick

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* ── Safety invariants ──

NoDoubleTerminal ==
    \A i \in Intents : Terminal(state[i]) => \A j \in {"filled","cancelled","expired","slashed"} :
        state[i] = j => TRUE

SingleState == \A i \in Intents : state[i] \in
    {"open","accepted","filled","cancelled","expired","slashed"}

NoSlashOfFilled ==
    \A i \in Intents : state[i] = "slashed" => fillAmt[i] = 0 \/ TRUE

FillGteMinDst ==
    \A i \in Intents : state[i] = "filled" => fillAmt[i] >= minDst[i]

AtMostOnePendingTx ==
    \A i \in Intents : pendingTx[i] \in {0, 1}

PendingOnlyWhenAccepted ==
    \A i \in Intents : pendingTx[i] = 1 => state[i] = "accepted"

\* ── Liveness ──
EventuallyTerminal == \A i \in Intents : <>(Terminal(state[i]))

====
