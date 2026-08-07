import type { AssistantFacade } from '@qvac/assistant'
import {
  createJournalSeqAllocator,
  resumeJournalSeq,
  type JournalSeqAllocator,
  CODE_EXECUTOR_CAPABILITY,
  decideClaimAction,
  decodeTurnPayload,
  formatSessionWorkId,
  isClaimGateId,
  parseClaimDecision,
  parseCodeWorkId,
  type CodeJournalBody
} from '@qvac-poc/qvac-code-shared'
import type { CodeMeshStore, CodeWorkRecord } from '@qvac-poc/qvac-code-shared/store'
import type { createApprovalBridge } from './approval-bridge.ts'
import {
  CODING_SKILL_NAME,
  CODING_TOOL_EDIT,
  CODING_TOOL_NAMES,
  CODING_TOOL_SHELL,
  CODING_TOOL_WRITE
} from './skills-impl/coding/names.ts'
import type { ExecutorIdentity } from './executor-identity.ts'
import type { createTurnRunner } from './turn-runner.ts'

const PRESENCE_INTERVAL_MS = 30_000
const PRESENCE_TTL_MS = 90_000
const DEFAULT_LOOP_INTERVAL_MS = 500
const CONFIRMATION_BARRIER_MS = 2_000
// decideClaimAction can only return 'open-claim-gate' once per pass over a
// given turn -- opening the gate makes claimGate non-null, which every other
// branch of the state machine handles without looping back to
// 'open-claim-gate' -- so one re-evaluation always suffices. The extra
// headroom is a defensive ceiling against a bug turning this into an
// infinite loop, not an expected path.
const MAX_CLAIM_REEVALUATIONS = 4

// See turn-runner.ts for why a plain Omit does not work against
// CodeJournalBody's union.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type JournalEntryBody = DistributiveOmit<CodeJournalBody, 'writer' | 'seq'>

export interface ExecutorDeps {
  readonly store: CodeMeshStore
  readonly assistant: Pick<AssistantFacade, 'run' | 'cancelRun' | 'registerAgent'>
  readonly identity: ExecutorIdentity
  readonly model: string
  readonly turnRunner: ReturnType<typeof createTurnRunner>
  readonly approvals: ReturnType<typeof createApprovalBridge>
  readonly now: () => number
  /**
   * Must resolve early when the signal passed to `run()` aborts, not run the
   * full duration. Shutdown promptness depends on it: both loops below only
   * re-check `signal.aborted` after their sleep resolves, so a sleep that
   * ignores the abort would delay exit by up to PRESENCE_INTERVAL_MS (30s).
   * The composition root satisfies this by binding the run signal into it
   * (see index.ts's `sleep(ms, signal)`); the signature cannot express it.
   */
  readonly sleep: (ms: number) => Promise<void>
  readonly onEvent?: (event: ExecutorEvent) => void
  readonly allowSecondExecutor: boolean
}

export type ExecutorEvent = {
  readonly kind:
    | 'presence'
    | 'claimed'
    | 'lost'
    | 'skipped'
    | 'started'
    | 'finished'
    | 'orphan'
    | 'error'
  readonly turnWorkId?: string
  readonly detail?: string
}

interface TurnRef {
  readonly sessionId: string
  readonly seq: number
}

export function createExecutor(deps: ExecutorDeps): {
  preflight(): Promise<void>
  recoverOrphans(): Promise<void>
  run(signal: AbortSignal): Promise<void>
} {
  const claimedInThisProcess = new Set<string>()
  const registeredAgents = new Set<string>()
  // executor.ts, turn-runner.ts and approval-bridge.ts all append to a turn's
  // journal as the same writer (this executor), and `seq` is both the
  // operationId discriminator and the transcript's render order. One allocator
  // per turn, shared by all three, is therefore the only scheme that keeps
  // appends distinct *and* the transcript in the order things happened.
  //
  // It is seeded from the journal rather than from zero because this executor's
  // identity is stable across restarts by design (see executor-identity.ts): a
  // turn-claim written by this process and a turn-interrupted written by a
  // later, restarted one share a writer id, and resuming past the highest
  // existing seq is what keeps their operationIds distinct.
  const seqAllocators = new Map<string, JournalSeqAllocator>()

  async function allocatorFor(turnWorkId: string) {
    const existing = seqAllocators.get(turnWorkId)
    if (existing) return existing
    const entries = await deps.store.listJournal(turnWorkId)
    const allocator = createJournalSeqAllocator(
      resumeJournalSeq(entries, deps.identity.executorId)
    )
    seqAllocators.set(turnWorkId, allocator)
    return allocator
  }

  async function preflight() {
    const executors = await deps.store.listExecutors()
    const now = deps.now()
    const capability = projectCapability(deps.identity.projectLabel)
    const conflict = executors.find(
      (executor) =>
        executor.executorId !== deps.identity.executorId &&
        executor.expiresAt > now &&
        executor.capabilities.includes(capability)
    )
    if (conflict == null || deps.allowSecondExecutor) return
    throw new Error(
      `another executor (${conflict.executorId}) is already advertising ${capability}. ` +
        'Pass --allow-second-executor to run a second executor for this project anyway -- ' +
        'running two executors on one project can duplicate work.'
    )
  }

  async function recoverOrphans() {
    const turns = await deps.store.listAvailableTurns()
    for (const work of turns) {
      try {
        if (await ownedByThisExecutor(work)) await recordInterrupted(work)
      } catch (error) {
        deps.onEvent?.({ kind: 'error', turnWorkId: work.workId, detail: describeError(error) })
      }
    }
  }

  async function ownedByThisExecutor(work: CodeWorkRecord) {
    const gates = await deps.store.listGates(work.workId)
    const claimGate = gates.find((gate) => isClaimGateId(gate.gateId)) ?? null
    const claim = claimGate ? parseClaimDecision(claimGate.decision) : null
    return claim != null && claim.executorId === deps.identity.executorId
  }

  async function recordInterrupted(work: CodeWorkRecord) {
    const parsed = parseCodeWorkId(work.workId)
    if (parsed == null || parsed.kind !== 'turn') return
    await appendExecutorEntry(work.workId, parsed, {
      type: 'turn-interrupted',
      executorId: deps.identity.executorId
    })
    // Never re-executed: the coding skill's tools already wrote to disk and
    // ran shell commands, none of which is idempotent at the effect level,
    // so replaying the same turn could duplicate or corrupt work. The only
    // safe retry is a *new* turn with a fresh workId -- left to whoever (a
    // person, or a future policy) decides to ask again.
    await deps.store.recordOutcome({ workId: work.workId, status: 'failed' })
    deps.onEvent?.({ kind: 'orphan', turnWorkId: work.workId })
  }

  async function run(signal: AbortSignal) {
    const presence = presenceLoop(signal)
    try {
      // Exit is prompt on abort, but only because every waiting point
      // observes the signal: deps.sleep resolves early (its contract above),
      // the per-turn loop in runOnePass returns on its next iteration, and an
      // in-flight executeTurn aborts through the controller it forwards the
      // signal into. Nothing here waits out DEFAULT_LOOP_INTERVAL_MS or
      // PRESENCE_INTERVAL_MS after a shutdown request.
      while (!signal.aborted) {
        await runOnePass(signal)
        if (signal.aborted) return
        await deps.sleep(DEFAULT_LOOP_INTERVAL_MS)
      }
    } finally {
      await presence
    }
  }

  async function presenceLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await deps.store.advertiseExecutor({
          executorId: deps.identity.executorId,
          expiresAt: deps.now() + PRESENCE_TTL_MS,
          capabilities: [CODE_EXECUTOR_CAPABILITY, projectCapability(deps.identity.projectLabel)]
        })
        deps.onEvent?.({ kind: 'presence' })
      } catch (error) {
        deps.onEvent?.({ kind: 'error', detail: `presence advertise failed: ${describeError(error)}` })
      }
      if (signal.aborted) return
      await deps.sleep(PRESENCE_INTERVAL_MS)
    }
  }

  async function runOnePass(signal: AbortSignal) {
    let turns: readonly CodeWorkRecord[]
    try {
      turns = await deps.store.listAvailableTurns()
    } catch (error) {
      deps.onEvent?.({ kind: 'error', detail: `listAvailableTurns failed: ${describeError(error)}` })
      return
    }
    const sorted = [...turns].sort((left, right) => left.createdAt - right.createdAt)
    for (const work of sorted) {
      if (signal.aborted) return
      try {
        await processTurn(work, signal)
      } catch (error) {
        // A single bad turn must not stop the executor from evaluating every
        // other turn, this pass or the next.
        deps.onEvent?.({ kind: 'error', turnWorkId: work.workId, detail: describeError(error) })
      }
    }
  }

  async function processTurn(work: CodeWorkRecord, signal: AbortSignal) {
    const parsed = parseCodeWorkId(work.workId)
    if (parsed == null || parsed.kind !== 'turn') return
    const session = await deps.store.getWork(formatSessionWorkId(parsed.sessionId))

    for (let attempt = 0; attempt < MAX_CLAIM_REEVALUATIONS; attempt++) {
      const gates = await deps.store.listGates(work.workId)
      const claimGate = gates.find((gate) => isClaimGateId(gate.gateId)) ?? null
      const action = decideClaimAction({
        executorId: deps.identity.executorId,
        work,
        session,
        claimGate,
        claimedInThisProcess: claimedInThisProcess.has(work.workId)
      })

      if (action.kind === 'skip') {
        deps.onEvent?.({ kind: 'skipped', turnWorkId: work.workId, detail: action.reason })
        return
      }
      if (action.kind === 'open-claim-gate') {
        // Safe even if a phone already opened it: the operationId is keyed
        // on the turn alone and the command bytes are identical, so a
        // second opener's attempt is a byte-identical no-op.
        await deps.store.openClaimGate({ sessionId: parsed.sessionId, seq: parsed.seq })
        continue
      }
      if (action.kind === 'attempt-claim') {
        await handleAttemptClaim(work, parsed, signal)
        return
      }
      if (action.kind === 'execute') {
        await executeTurn(work, parsed, signal)
        return
      }
      if (action.kind === 'record-interrupted') {
        await recordInterrupted(work)
        return
      }
      // 'confirm-claim' is never returned by decideClaimAction itself; it
      // only names the caller's next step, which handleAttemptClaim below
      // implements directly.
      return
    }
    deps.onEvent?.({ kind: 'error', turnWorkId: work.workId, detail: 'gave up re-evaluating the claim gate' })
  }

  async function handleAttemptClaim(work: CodeWorkRecord, parsed: TurnRef, signal: AbortSignal) {
    const outcome = await deps.store.claimTurn({
      sessionId: parsed.sessionId,
      seq: parsed.seq,
      executorId: deps.identity.executorId
    })
    if (outcome.kind === 'lost') {
      deps.onEvent?.({ kind: 'lost', turnWorkId: work.workId, detail: outcome.winner })
      return
    }
    if (outcome.kind === 'unreachable') {
      deps.onEvent?.({ kind: 'error', turnWorkId: work.workId, detail: `claim unreachable: ${outcome.error.message}` })
      return
    }

    // 'won', per store.claimTurn's own immediate read-back -- but only as of
    // that moment. A concurrent resolve-gate from another device can still
    // merge in afterwards and, under deterministic conflict resolution, turn
    // out to be the one that actually wins once the mesh catches up. Add to
    // the claimed set and record the win immediately (a later abort must
    // still recognise this as our own claim, not an orphan), then wait out a
    // confirmation barrier and re-read before trusting it enough to start
    // real side effects.
    claimedInThisProcess.add(work.workId)
    await appendExecutorEntry(work.workId, parsed, {
      type: 'turn-claim',
      executorId: deps.identity.executorId,
      result: 'won'
    })
    deps.onEvent?.({ kind: 'claimed', turnWorkId: work.workId })

    await deps.sleep(CONFIRMATION_BARRIER_MS)
    if (signal.aborted) return

    const gates = await deps.store.listGates(work.workId)
    const claimGate = gates.find((gate) => isClaimGateId(gate.gateId)) ?? null
    const claim = claimGate ? parseClaimDecision(claimGate.decision) : null

    if (claim != null && claim.executorId === deps.identity.executorId) {
      await executeTurn(work, parsed, signal)
      return
    }
    if (claim != null) {
      await appendExecutorEntry(work.workId, parsed, {
        type: 'turn-superseded',
        executorId: deps.identity.executorId,
        winner: claim.executorId
      })
      deps.onEvent?.({ kind: 'lost', turnWorkId: work.workId, detail: claim.executorId })
      return
    }
    // Anomalous: resolve-gate is create-only, so a decided gate should never
    // revert to undecided. Report it rather than guessing at a winner to
    // name in a turn-superseded entry.
    deps.onEvent?.({
      kind: 'error',
      turnWorkId: work.workId,
      detail: 'confirmation barrier: claim gate lost its decision'
    })
  }

  async function executeTurn(work: CodeWorkRecord, parsed: TurnRef, signal: AbortSignal) {
    const agentId = `code/${parsed.sessionId}`
    await ensureAgentRegistered(agentId)

    const payload = decodeTurnPayload(work.payload)
    const entrySeq = await allocatorFor(work.workId)
    const track = deps.approvals.track({
      turnWorkId: work.workId,
      sessionId: parsed.sessionId,
      seq: parsed.seq,
      runId: work.workId,
      entrySeq
    })

    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal.reason)
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forwardAbort, { once: true })
    const stopCancelWatch = watchCancelRequested(work.workId, agentId, controller)

    deps.onEvent?.({ kind: 'started', turnWorkId: work.workId })
    try {
      const result = await deps.turnRunner.run({
        sessionId: parsed.sessionId,
        seq: parsed.seq,
        turnWorkId: work.workId,
        prompt: payload.prompt,
        agentId,
        signal: controller.signal,
        entrySeq
      })
      deps.onEvent?.({ kind: 'finished', turnWorkId: work.workId, detail: result.status })
    } finally {
      stopCancelWatch()
      signal.removeEventListener('abort', forwardAbort)
      await deps.approvals.closeTurn(work.workId)
      track.release()
    }
  }

  async function ensureAgentRegistered(agentId: string) {
    if (registeredAgents.has(agentId)) return
    await deps.assistant.registerAgent({
      id: agentId,
      model: deps.model,
      skills: [CODING_SKILL_NAME],
      // write, edit, and shell are side-effecting; the coding skill host
      // also marks them mandatory (see lib/skills-impl/coding/host.ts), but
      // the agent's own policy must ask for approval independently rather
      // than relying only on that.
      toolPolicy: {
        allow: [...CODING_TOOL_NAMES],
        requireApproval: [CODING_TOOL_WRITE, CODING_TOOL_EDIT, CODING_TOOL_SHELL]
      }
    })
    registeredAgents.add(agentId)
  }

  function watchCancelRequested(workId: string, agentId: string, controller: AbortController) {
    let stopped = false
    async function poll() {
      while (!stopped && !controller.signal.aborted) {
        await deps.sleep(DEFAULT_LOOP_INTERVAL_MS)
        if (stopped || controller.signal.aborted) return
        try {
          const work = await deps.store.getWork(workId)
          if (work?.cancelRequested) {
            controller.abort('cancel-requested')
            // Aborting the shared signal is what actually stops
            // turnRunner's harness stream (the harness itself listens for
            // that signal and cancels the underlying agent run -- see
            // packages/harness/lib/harness.ts's runAgent). Also calling the
            // harness's own cancellation RPC directly is redundant with
            // that, but cheap and more explicit than relying solely on
            // signal-forwarding; best effort, since the run may already be
            // finishing on its own by the time this lands.
            await deps.assistant.cancelRun({ agentId, runId: workId, reason: 'cancel-requested' }).catch(() => {})
            return
          }
        } catch (error) {
          deps.onEvent?.({ kind: 'error', turnWorkId: workId, detail: `cancel poll failed: ${describeError(error)}` })
        }
      }
    }
    void poll()
    return () => {
      stopped = true
    }
  }

  async function appendExecutorEntry(
    workId: string,
    parsed: TurnRef,
    body: JournalEntryBody
  ) {
    const allocator = await allocatorFor(workId)
    const seq = allocator.next()
    return deps.store
      .appendEntry({
        sessionId: parsed.sessionId,
        seq: parsed.seq,
        body: { ...body, writer: deps.identity.executorId, seq }
      })
      .catch((error) => {
        // Losing this bookkeeping line does not lose any authoritative
        // state -- the claim gate and the recorded outcome are what
        // decideClaimAction and future passes actually read -- so report and
        // move on rather than letting a journal write failure abort the
        // claim loop.
        deps.onEvent?.({ kind: 'error', turnWorkId: workId, detail: `journal append failed: ${describeError(error)}` })
      })
  }

  return { preflight, recoverOrphans, run }
}

function projectCapability(projectLabel: string) {
  return `project/${projectLabel}`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
