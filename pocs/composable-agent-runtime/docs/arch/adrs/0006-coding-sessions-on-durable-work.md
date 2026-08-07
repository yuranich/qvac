# ADR 0006: Coding Sessions on Durable Work, and the Claim as a Gate

Status: Proposed
Date: 2026-08-06
Related: [ADR 0004](0004-separate-bare-runtimes-for-sync-harness-and-sdk.md),
[TD-DURABLE-WORK-CLAIM-GUARANTEES](../tech-debt/TD-DURABLE-WORK-CLAIM-GUARANTEES.md)

## Context

`apps/qvac-code` is a coding agent whose sessions are created on a phone and
executed on a laptop. It needs a replicated representation of a session, its
turns, the streaming transcript of each turn, and the approvals the agent must
obtain before writing a file or running a command.

The only replicated-state surface available is `durableWorkProfile`
(`packages/sync/lib/profiles/durable-work/`). It offers a work envelope with an
immutable payload, an append-only journal, one-shot cancellation, a checkpoint
reference, gates, an outcome, and executor presence. Four properties of that
profile and of Sync's apply path constrain every option, and were verified
against source rather than assumed:

1. **`apply()` throws on a rejected transition.** `mesh.ts:295-311` re-reads the
   operation after appending and throws `Invalid Sync profile transition for
   operation <id>` when it is absent. The same throw covers a lost race, a
   transport failure, and a read-only peer. A caller cannot distinguish them
   from the error.
2. **`operationId` dedup compares raw command bytes.** Reuse with different
   bytes throws; byte-identical reuse returns the existing revision
   (`mesh.ts:246-262`). Bytes come from `JSON.stringify` over `Object.keys`
   insertion order.
3. **`expectedRevision` is profile-wide.** It compares against
   `PROFILE_HEADS[profileId]` (`mesh.ts:263-272`), one revision bumped by every
   operation from every consumer of the profile, and a mismatch inside the
   linearized apply is a silent `return`.
4. **A watch re-runs its whole query and re-serializes the encoded result on
   every mesh change.** `watchable.ts:41-44` dedupes with `JSON.stringify` over
   the encoded Buffer, roughly six characters per byte, woken by any change
   anywhere in the mesh.

The profile also declared a `gate` capability that could be written but never
read: there was no query returning gate rows.

## Decision

### A session is one envelope; each turn is its own envelope

```
session workId: code/<sessionId>
turn workId:    code/<sessionId>/turn/<seq padded to 6>
```

Turns are prefix-derivable from `list-work`, so no session index is needed.

Rejected alternative: one envelope per session with turns in the journal.

- `list-available-work` means "no outcome, no cancel" (`reducer.ts:93-99`). With
  per-turn envelopes that query *is* the executor's queue, with no journal
  scanning. A session envelope would sit in it for the session's whole life.
- `request-cancel` is one-shot and irreversible per envelope
  (`reducer.ts:212-231`). With one envelope per session, cancelling a single turn
  would poison the session permanently.
- `record-outcome` is exactly-once per workId, so per-turn outcomes give a
  restarting executor its unfinished set from one query instead of a journal
  fold that a second writer can corrupt.
- Property 4 makes journal size a cost every device pays on every wake. A
  per-turn journal is bounded by one turn; a session-long one is not.

### The claim is a gate

An executor claims a turn with `resolve-gate` on a `claim` gate whose decision
is `claim/<executorId>`. `resolve-gate` rejects an already-decided gate, so
exactly one claim can ever succeed, and the winner becomes a replicated field.

Rejected alternatives:

- **A journal entry.** `append-journal` never arbitrates, so two claim entries
  simply both exist.
- **A derived `claim:<turnId>` work envelope**, exploiting create-only
  `record-work`. Equally atomic, but it adds a row to the two most-watched
  queries, which property 4 makes expensive.
- **`expectedRevision` as a CAS.** Property 3 rules it out: it loses to
  unrelated journal traffic and fails silently. This design uses it nowhere.

### Stored state arbitrates, never a thrown error

Because of property 1, every contended write in
`apps/qvac-code/shared/store.ts` re-reads the row afterwards and returns a
three-way result — `won`, `lost`, or `unreachable` — rather than inferring
anything from the throw. `unreachable` is deliberately not a denial: it means
nobody decided, and a caller that treats it as a decision would act on a verdict
no one made.

### One command factory

Property 2 makes byte-identity a correctness requirement, not a style
preference. Every command is built in `apps/qvac-code/shared/commands.ts` with a
fixed key order, together with a deterministic `operationId`. That is what lets
the executor safely re-issue the `open-gate` a phone died before sending: the
command dedupes instead of clobbering.

### Approvals are gates; either device may decide

The laptop holds the authoritative harness approval stream. For each request it
appends an `approval-requested` journal entry **then** opens a gate, so a peer
that sees the gate can already describe it. It prompts locally and watches the
gate concurrently; the first decision to land in the gate wins, and the loser
adopts the stored decision verbatim.

The harness approval port is tri-state on purpose
(`packages/harness/lib/approval-port.ts:25-30`). `withdrawn` and `unanswered`
resolve the harness call with `approved: false`, but every replicated and
user-visible surface keeps saying which of the two it was, never "denied".

### Turn status comes only from arbitrated state

`append-journal` neither checks that the caller won the claim nor stamps an
authenticated identity, and `SyncDurableWorkJournalEntry` has no column for one.
A journal entry's `writer` is therefore self-declared. Status is derived only
from the work row's outcome and cancel flag and from the CAS-arbitrated gates.
There is deliberately no `superseded` status: a superseded *writer* is a display
concern, and deriving a terminal state from a forgeable field would let any
admitted peer retire a live turn on every other device's screen.

## Consequences

Sync gains `list-gates` and `list-open-gates` and a `gate-read` capability, and
`open-gate` becomes create-only — a second open previously cleared an existing
decision, re-asking a question that had already been answered.

`list-open-gates` returns only outstanding decisions, so the cost that property 4
above makes expensive — re-serializing a watch's whole encoded result on every
mesh change — stays flat as history grows. Its *scan* does not: like every query
in this reducer it reads the whole table and filters afterwards, so it walks every
gate ever recorded. That asymmetry is what makes it cheap to watch and not cheap
to call in a tight loop.

`gate-read` is declared, not negotiated. Nothing reads
`SyncProfileContract.capabilities` anywhere in the tree, so it records the
distinction for a future reader rather than enforcing it; a peer talking to an
older runtime still discovers the gap by having its query rejected.

`DurableWorkResult` also grows another required array, continuing its shape as a
bag of fields where each query populates one. That follows the existing local
convention, but per-query result types would make the invalid combinations
unrepresentable, and this profile should get them before it graduates from the
PoC.

Assistant gains `workers`, `host` and `listSkills()`, because an application
composing through the facade could not otherwise reach its own skills — a
standing-rule violation rather than a missing feature.

What this does **not** buy is a guarantee against two laptops executing one
turn. The claim narrows the window and makes single-executor restart safe, but
leases, fencing and stale reclaim remain unbuilt; see the tech-debt note.
