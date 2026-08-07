# TD-DURABLE-WORK-CLAIM-GUARANTEES

Status: Open
Date: 2026-08-06
Related: [ADR 0006](../adrs/0006-coding-sessions-on-durable-work.md),
QIP Phase 0 gate "Trust and claims"

## What this records

`apps/qvac-code` executes replicated work claimed from a mesh. ADR 0006 builds
the claim from the only test-and-set the durable-work profile has, which makes
single-executor restart safe. It does **not** make concurrent execution safe.

The QIP already states that "remote execution remains duplicate-possible until
Phase 0 defines leases, fencing, stale reclaim, cancellation, and effect-level
idempotency" and that "claims, fencing, and tool idempotency remain domain
policy, not Supervisor behavior". This note is the concrete inventory behind
that sentence, written from the implementation rather than from the design.

## What is guaranteed

**No double execution across a restart of one executor.** The claim precedes the
run; `executorId` is derived from hostname plus the realpath hash of the project,
so it is stable across restarts; a turn whose claim names us with no outcome is
marked `failed` at startup rather than resumed; and `record-outcome` is
exactly-once per workId. There is no path by which one executor runs one turn
twice.

Auto-resume is deliberately absent. The skill has already written to the
filesystem by the time a crash is noticed, and there is no effect-level
idempotency, so a resumed turn could repeat a write or a command. Retry is a
*new* turn with a new workId, which the user can see diverging.

## What is not guaranteed

| # | Race | Mechanism | Containment today |
|---|---|---|---|
| R1 | **Replication latency.** `applyProfile` appends to the local writer core, calls `update()`, then reads the local view (`mesh.ts:290-295`). If a peer's claim block has not linearized locally, both executors see their own `resolve-gate` accepted and both believe they won. On merge Autobase deterministically drops one — after that executor has started the model and possibly written files. | No fencing token is presented on side-effecting writes, so nothing downstream can reject the loser's effects. | A confirmation barrier: after winning, the executor waits, re-reads the gate, and abandons the turn if it no longer names it. This shrinks the window; it cannot close it. |
| R2 | **Partition.** Two executors paired to the same mesh but not to each other both claim, both run to completion, both `record-outcome`. One claim and one outcome survive the merge, but **both journals survive** — `append-journal` never arbitrates. | Display-only: every entry carries `writer`, and `projectTurn` renders only the surviving claim owner's entries, greying the rest behind a superseded notice. | The loser's filesystem effects on its own machine are real and unrecoverable by anything in this profile. |
| R3 | **No stale reclaim.** `resolve-gate` is one-shot with no un-resolve; `SyncDurableWorkGate` has no mutable owner field; `advertise-executor` has no revocation and no reaper, and its `expiresAt` is compared against a different device's clock. A claim held by a laptop that never returns **wedges that turn forever.** | None. | Recovery is human: `request-cancel` the wedged turn, which the reducer still permits while `outcomeStatus` is null, and submit a new one. A heuristic timeout was deliberately **not** added: reclaim without a fencing token converts a *possible* double execution into a *guaranteed* one. |
| R4 | **`expectedRevision` cannot help.** It is a profile-wide CAS bumped by every operation from every consumer (`mesh.ts:263-272`), so it loses to unrelated journal traffic, and a mismatch inside the linearized apply is a silent `return`. | Not used anywhere in this app. | n/a |

## Unauthenticated journal writers

`append-journal` checks only that the work row exists (`reducer.ts:143-153`). It
does not check that the caller won the claim gate, and
`SyncDurableWorkJournalEntry` has no column for an authenticated writer identity,
so the `writer` field in every journal body is self-declared.

Consequences, and what the app does about them:

- **Status is not derived from journal entries.** Only the work row's outcome and
  cancel flag and the CAS-arbitrated gates decide a turn's status. Without this,
  a forged `turn-superseded` attributed to the winning executor would retire a
  live turn on every device's screen. There is no `superseded` status as a
  result.
- **Content is still forgeable.** An admitted peer can append plausible
  `assistant-delta` or `tool-result` entries attributed to the winner, including
  marking a failed tool call as successful. Nothing in the app can tell them
  apart. Bounded, not fixed: `writer` must match the executor-id grammar, so only
  executor-shaped writers can author entries at all.
- **Flooding is bounded per entry, not per journal.** A body over 64 KB is
  rejected before parsing, because every watching peer decodes every entry on
  every wake. The number of entries a remote writer may append is still
  unbounded — the batcher's per-turn budget only throttles what this process
  chooses to emit.

The real fix is Sync-side: an authenticated writer identity stamped by
`ProfileApplyContext` at apply time, and an append authorization check tying
journal writes to the claim owner. Both are outside this app's boundary.

## Not measured

Nothing here has been measured against a real two-laptop mesh. `serve` refuses
to start when another live executor advertises the same project, so the default
demo cannot exercise R1 or R2 at all; `--allow-second-executor` exists to
deliberately provoke them, and the chaos test uses it to *document* the races
rather than to assert their absence.

## What would close this

Phase 0's "Trust and claims" gate: lease acquisition with an expiry the holder
renews, a fencing token every side-effecting operation must present, stale
reclaim that invalidates the previous holder's token, and tool-level idempotency
keys. Until those exist, an application on this profile should treat
single-executor-per-scope as a precondition it enforces, not an assumption it
makes.
