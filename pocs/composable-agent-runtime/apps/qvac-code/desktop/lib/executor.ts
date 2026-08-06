import type { AssistantFacade } from '@qvac/assistant'
import {
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
  // executor.ts, turn-runner.ts, and approval-bridge.ts all append journal
  // entries as the same writer (this executor) for a turn's journal, and
  // Sync's operationId for an entry is keyed on (turnWorkId, writer, seq) --
  // see the fuller explanation in approval-bridge.ts. turn-runner.ts's
  // per-run counter is safe to reset to 0 on every run() call because a turn
  // is never re-executed once claimed (see recordInterrupted below), so its
  // entries for a given turnWorkId only ever come from one process
  // lifetime. executor.ts's own bookkeeping entries (turn-claim,
  // turn-superseded, turn-interrupted) do not have that guarantee: this
  // executor's identity is stable across restarts by design (see
  // executor-identity.ts), so a turn-claim this process writes today and a
  // turn-interrupted a *later, restarted* process writes for the same turn
  // share a writer id but come from different process lifetimes. A counter
  // that resets on each call would collide across that restart the same way
  // a per-run reset would; real wall-clock time -- which always advances
  // across a restart -- disambiguates it for free. The nonce only guards the
  // (rare, same-process) case of two entries landing in the same clock
  // tick.
  let executorEntryNonce = 0

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
      // Sleep here has no signal of its own (see ExecutorDeps.sleep), so a
      // pass already in flight and the interval between passes both run to
      // completion before this loop notices an abort -- bounded by
      // DEFAULT_LOOP_INTERVAL_MS, an acceptable shutdown latency for a PoC.
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
    const track = deps.approvals.track({
      turnWorkId: work.workId,
      sessionId: parsed.sessionId,
      seq: parsed.seq,
      runId: work.workId
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
        signal: controller.signal
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

  function appendExecutorEntry(
    workId: string,
    parsed: TurnRef,
    body: JournalEntryBody
  ) {
    const seq = deps.now() + executorEntryNonce++
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
