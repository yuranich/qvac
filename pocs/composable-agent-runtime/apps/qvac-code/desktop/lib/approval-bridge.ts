import type { AssistantFacade } from '@qvac/assistant'
import type { HarnessApprovalRequest } from '@qvac/harness'
import {
  type JournalSeqAllocator,
  formatApprovalGateId,
  isClaimGateId,
  parseApprovalDecision,
  parseCodeWorkId,
  toHarnessResolution,
  type CodeApprovalDecision
} from '@qvac-poc/qvac-code-shared'
import type { CodeMeshStore } from '@qvac-poc/qvac-code-shared/store'

/** How often the mesh arm of the race re-reads the gate while nothing has
 * decided it yet. A `watch` would wake faster, but `store.watchOpenGates` is
 * mesh-wide (every open gate, on every mesh change) where this needs one
 * specific gate on one specific turn, so polling is simpler than filtering a
 * firehose down to one id on every wake.
 *
 * Simpler, but not cheap: `listGates` is not a point read. The durable-work
 * reducer answers `list-gates` by scanning the whole GATES table and
 * filtering by workId afterwards
 * (packages/sync/lib/profiles/durable-work/reducer.ts:81-89), so each poll
 * costs a full scan of every gate ever opened across the mesh, and N
 * concurrently pending approvals poll N times over the same table. Both arms
 * of the tradeoff are therefore mesh-wide reads; polling wins on simplicity
 * alone. Collapsing all pending approvals onto one shared `listOpenGates`
 * tick is the fix if this ever leaves PoC scale. */
const APPROVAL_POLL_INTERVAL_MS = 400

// approval-bridge.ts and turn-runner.ts both append journal entries as the
// same writer (this executor) for the same turn, concurrently -- a tool call
// that needs approval blocks the harness event stream turn-runner.ts is
// draining, while this module races the decision in parallel. Sync's
// operationId for an entry is keyed on (turnWorkId, writer, seq), so if both
// modules started their own seq counter at 0 independently, their entries
const DETAIL_VALUE_MAX_LENGTH = 200
const SUMMARY_MAX_LENGTH = 120
const MAX_DETAIL_LINES = 8

export interface ApprovalPrompt {
  readonly gateId: string
  readonly turnWorkId: string
  readonly toolName: string
  readonly summary: string
  readonly detail: readonly string[]
}

export interface ApprovalBridgeDeps {
  readonly store: CodeMeshStore
  readonly assistant: Pick<AssistantFacade, 'approvals'>
  readonly executorId: string
  readonly now: () => number
  readonly approvalDeadlineMs: number
  /** Renders a prompt locally and resolves with the local answer, or never
   * resolves if the user does not answer. Must honour the signal. */
  readonly promptLocally: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean>
  readonly onResolved?: (input: {
    readonly prompt: ApprovalPrompt
    readonly decision: CodeApprovalDecision
  }) => void
}

interface TrackedTurn {
  readonly turnWorkId: string
  readonly sessionId: string
  readonly seq: number
  readonly runId: string
  gateIndex: number
  readonly entrySeq: JournalSeqAllocator
  readonly openGates: Map<string, AbortController>
}

type RaceWinner =
  | { readonly source: 'local'; readonly approved: boolean }
  | { readonly source: 'mesh'; readonly decision: CodeApprovalDecision }
  | { readonly source: 'deadline' }

export function createApprovalBridge(deps: ApprovalBridgeDeps): {
  track(input: {
    readonly turnWorkId: string
    readonly sessionId: string
    readonly seq: number
    readonly runId: string
    readonly entrySeq: JournalSeqAllocator
  }): { release(): void }
  start(signal: AbortSignal): Promise<void>
  closeTurn(turnWorkId: string): Promise<void>
  reconcile(): Promise<void>
} {
  const byRunId = new Map<string, TrackedTurn>()
  const byTurnWorkId = new Map<string, TrackedTurn>()

  function track(input: {
    readonly turnWorkId: string
    readonly sessionId: string
    readonly seq: number
    readonly runId: string
    readonly entrySeq: JournalSeqAllocator
  }) {
    const tracked: TrackedTurn = {
      turnWorkId: input.turnWorkId,
      sessionId: input.sessionId,
      seq: input.seq,
      runId: input.runId,
      gateIndex: 0,
      entrySeq: input.entrySeq,
      openGates: new Map()
    }
    byRunId.set(input.runId, tracked)
    byTurnWorkId.set(input.turnWorkId, tracked)
    return {
      release() {
        byRunId.delete(input.runId)
        byTurnWorkId.delete(input.turnWorkId)
      }
    }
  }

  async function start(signal: AbortSignal) {
    for await (const request of deps.assistant.approvals.pending()) {
      if (signal.aborted) return
      // Fire-and-forget: a slow-to-answer approval on one turn must not
      // block routing requests for a different, concurrently tracked turn.
      // Errors are reported, never thrown into this loop -- a single bad
      // request must not stop every other approval from being routed.
      void handleRequest(request, signal).catch((error) => {
        console.error(`[approval-bridge] failed to handle approval ${request.approvalId}: ${describeError(error)}`)
      })
    }
  }

  async function handleRequest(request: HarnessApprovalRequest, outerSignal: AbortSignal) {
    const tracked = byRunId.get(request.runId)
    if (tracked == null) {
      // A gate for a run nobody can execute is a prompt that can never mean
      // anything -- there is no turn journal to attach it to, and no local
      // context to decide it against. Fail closed immediately and write no
      // gate at all, rather than opening one nobody will ever resolve.
      await deps.assistant.approvals.resolve({ approvalId: request.approvalId, approved: false })
      return
    }

    const requestedAt = deps.now()
    tracked.gateIndex += 1
    const gateId = formatApprovalGateId({ executorId: deps.executorId, index: tracked.gateIndex })
    const prompt: ApprovalPrompt = {
      gateId,
      turnWorkId: tracked.turnWorkId,
      toolName: request.name,
      summary: summarizeApproval(request.name, request.args),
      detail: detailLines(request.args)
    }

    // The entry is appended before the gate opens: a peer that observes the
    // gate opening (via watchOpenGates) must already be able to render what
    // it is being asked to decide, not see an open gate with nothing to
    // show while the detail entry is still in flight.
    await appendApprovalEntry(tracked, {
      type: 'approval-requested',
      gateId,
      name: prompt.toolName,
      summary: prompt.summary,
      detail: prompt.detail
    })
    await deps.store.openApprovalGate({ sessionId: tracked.sessionId, seq: tracked.seq, gateId })

    const controller = new AbortController()
    tracked.openGates.set(gateId, controller)
    const forwardAbort = () => controller.abort(outerSignal.reason)
    if (outerSignal.aborted) controller.abort(outerSignal.reason)
    else outerSignal.addEventListener('abort', forwardAbort, { once: true })

    try {
      const decision = await raceDecision(tracked, gateId, prompt, controller.signal, requestedAt)
      tracked.openGates.delete(gateId)
      // Derived from the gate's decision, never from the local answer, so
      // the journal can never contradict the gate: on a 'lost' local race
      // this is the peer's verdict, not ours.
      await appendApprovalEntry(tracked, { type: 'approval-resolved', gateId, decision, reason: null })
      deps.onResolved?.({ prompt, decision })

      const resolution = toHarnessResolution(decision.verdict)
      await deps.assistant.approvals.resolve({
        approvalId: request.approvalId,
        // A fail-closed resolution still tells the harness { approved: false
        // } -- the tool loop only understands go/no-go -- but that boolean
        // must never leak onto a user-visible surface as "denied". Every
        // display path reads the gate's actual verdict (withdrawn /
        // unanswered), which is exactly the hazard approval-port.ts's
        // HarnessApprovalOutcome doc comment warns about: collapsing
        // "nobody decided" into a denial lets a caller wrongly treat it as a
        // real answer.
        approved: resolution.kind === 'decided' ? resolution.approved : false
      })
    } finally {
      outerSignal.removeEventListener('abort', forwardAbort)
      // Stop whichever race arms did not win: dismiss the local prompt (via
      // promptLocally's own signal handling), stop polling, clear the
      // deadline timer. Safe to call unconditionally; already-aborted is a
      // no-op.
      controller.abort()
    }
  }

  async function raceDecision(
    tracked: TrackedTurn,
    gateId: string,
    prompt: ApprovalPrompt,
    signal: AbortSignal,
    requestedAt: number
  ): Promise<CodeApprovalDecision> {
    const winner = await Promise.race([
      localArm(prompt, signal),
      meshArm(tracked, gateId, signal),
      deadlineArm(signal)
    ])

    if (winner.source === 'mesh') {
      // Someone else's decision already won the gate -- we must not call
      // resolveApprovalGate ourselves, only adopt what is there.
      return winner.decision
    }

    const verdict = winner.source === 'local' ? (winner.approved ? 'approved' : 'denied') : 'unanswered'
    const decidedBy =
      winner.source === 'local'
        ? ({ kind: 'executor', executorId: deps.executorId } as const)
        : ({ kind: 'policy', rule: 'deadline' } as const)
    const outcome = await deps.store.resolveApprovalGate({
      sessionId: tracked.sessionId,
      seq: tracked.seq,
      gateId,
      decision: { verdict, decidedBy }
    })
    if (outcome.kind === 'won') return outcome.decision
    if (outcome.kind === 'lost') {
      // Someone else's resolve-gate landed first even though ours also
      // reached the mesh -- the stored decision is the arbiter, never our
      // own attempt, so adopt it verbatim.
      return outcome.decision
    }
    // 'unreachable': there is no two-phase commit across an Autobase append
    // and an in-process harness stream, so we cannot know whether the mesh
    // actually recorded our decision. Honour it locally toward the harness
    // anyway -- the alternative is hanging the tool call forever -- but log
    // the divergence, since a peer reading the gate later may see something
    // else (or nothing) rather than the verdict we are about to act on.
    console.error(
      `[approval-bridge] gate ${gateId} unreachable ${deps.now() - requestedAt}ms after resolving locally ` +
        `as ${verdict}; honouring the local verdict but the mesh record may not match: ${outcome.error.message}`
    )
    return { verdict, decidedBy }
  }

  function localArm(prompt: ApprovalPrompt, signal: AbortSignal): Promise<RaceWinner> {
    return deps.promptLocally(prompt, signal).then((approved) => ({ source: 'local' as const, approved }))
  }

  function meshArm(tracked: TrackedTurn, gateId: string, signal: AbortSignal): Promise<RaceWinner> {
    return new Promise((resolve) => {
      let settled = false
      let cancelled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      function finish(winner: RaceWinner) {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(winner)
      }

      async function readDecision(): Promise<CodeApprovalDecision | null> {
        const gates = await deps.store.listGates(tracked.turnWorkId)
        const gate = gates.find((candidate) => candidate.gateId === gateId)
        return gate?.decision != null ? parseApprovalDecision(gate.decision) : null
      }

      async function onAbort() {
        cancelled = true
        if (timer) clearTimeout(timer)
        // The signal aborts either because another arm already won, or
        // because closeTurn/reconcile just withdrew this gate from outside
        // the race entirely. The latter writes the gate *then* aborts (see
        // closeTurn) specifically so this final read can observe it -- without
        // it, cancelling the poll timer here would leave that write
        // unobserved and handleRequest hung forever waiting on a race no arm
        // will ever win.
        try {
          const decision = await readDecision()
          if (decision != null) finish({ source: 'mesh', decision })
        } catch {
          // Nothing more to do; if another arm also cannot resolve, the
          // caller is left waiting, which is the same failure mode as any
          // other mesh outage.
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })

      async function tick() {
        if (cancelled) return
        try {
          const decision = await readDecision()
          if (decision != null) {
            finish({ source: 'mesh', decision })
            return
          }
        } catch (error) {
          // A transient read failure must not kill the race silently -- keep
          // polling; the deadline arm is the actual backstop.
          console.error(`[approval-bridge] gate poll failed for ${gateId}: ${describeError(error)}`)
        }
        if (cancelled) return
        timer = setTimeout(() => void tick(), APPROVAL_POLL_INTERVAL_MS)
      }
      void tick()
    })
  }

  function deadlineArm(signal: AbortSignal): Promise<RaceWinner> {
    return new Promise((resolve) => {
      if (signal.aborted) return // Never resolves; another arm already won.
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve({ source: 'deadline' })
      }, deps.approvalDeadlineMs)
      function onAbort() {
        clearTimeout(timer)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async function appendApprovalEntry(
    tracked: TrackedTurn,
    body:
      | { readonly type: 'approval-requested'; readonly gateId: string; readonly name: string; readonly summary: string; readonly detail: readonly string[] }
      | { readonly type: 'approval-resolved'; readonly gateId: string; readonly decision: CodeApprovalDecision; readonly reason: string | null }
  ) {
    const seq = tracked.entrySeq.next()
    try {
      await deps.store.appendEntry({
        sessionId: tracked.sessionId,
        seq: tracked.seq,
        body: { ...body, writer: deps.executorId, seq }
      })
    } catch (error) {
      // Losing an approval-requested/resolved journal line does not lose the
      // decision itself -- that lives on the gate, which is what
      // resolveApprovalGate and the harness resolution above both act on --
      // so this is a transcript-completeness problem, not a correctness one.
      console.error(`[approval-bridge] journal append failed for turn ${tracked.turnWorkId}: ${describeError(error)}`)
    }
  }

  async function closeTurn(turnWorkId: string) {
    const tracked = byTurnWorkId.get(turnWorkId)
    if (tracked == null || tracked.openGates.size === 0) return
    const decision: CodeApprovalDecision = {
      verdict: 'withdrawn',
      decidedBy: { kind: 'policy', rule: 'run-ended' }
    }
    // There is no withdrawal signal on the harness's own approval watch
    // stream (createHarnessApprovalHost deletes the outstanding entry and
    // pushes nothing further), so a turn's own lifetime -- this call, made
    // when execution finishes -- is the only signal a peer's still-open
    // prompt will ever get that it should stop waiting.
    //
    // Write before aborting, not after: a still-running handleRequest for
    // this gate is racing localArm/meshArm/deadlineArm, and aborting cancels
    // meshArm's poll timer. meshArm does one last gate read when it is
    // aborted (see below) specifically so this write is not missed -- but
    // only if the write has already landed by the time that read runs.
    // Aborting first would race the write against that read with no
    // guaranteed order and could leave handleRequest hung forever.
    for (const [gateId, controller] of tracked.openGates) {
      try {
        await deps.store.resolveApprovalGate({
          sessionId: tracked.sessionId,
          seq: tracked.seq,
          gateId,
          decision
        })
      } catch (error) {
        console.error(`[approval-bridge] failed to withdraw gate ${gateId} for ${turnWorkId}: ${describeError(error)}`)
      }
      controller.abort()
    }
    tracked.openGates.clear()
  }

  async function reconcile() {
    const gates = await deps.store.listOpenGates()
    for (const gate of gates) {
      if (isClaimGateId(gate.gateId)) continue
      const parsed = parseCodeWorkId(gate.workId)
      if (parsed == null || parsed.kind !== 'turn') continue
      const work = await deps.store.getWork(gate.workId)
      if (work == null || work.outcomeStatus == null) continue
      try {
        await deps.store.resolveApprovalGate({
          sessionId: parsed.sessionId,
          seq: parsed.seq,
          gateId: gate.gateId,
          decision: { verdict: 'withdrawn', decidedBy: { kind: 'policy', rule: 'run-ended' } }
        })
      } catch (error) {
        console.error(`[approval-bridge] reconcile failed to close gate ${gate.gateId} on ${gate.workId}: ${describeError(error)}`)
      }
    }
  }

  return { track, start, closeTurn, reconcile }
}

// HarnessApprovalRequest.args is typed as Record<string, unknown> (unlike
// HarnessEvent's tool-call, which is HarnessJsonValue) -- the approval port
// deliberately does not narrow it, since it only ever forwards these values
// for display. renderValue below handles arbitrary unknown values the same
// defensive way regardless.
function summarizeApproval(toolName: string, args: Readonly<Record<string, unknown>>): string {
  const primary = firstStringArg(args, ['filePath', 'command', 'pattern', 'path'])
  const text = primary == null ? toolName : `${toolName} ${primary}`
  return truncate(text, SUMMARY_MAX_LENGTH)
}

function detailLines(args: Readonly<Record<string, unknown>>): readonly string[] {
  const lines: string[] = []
  for (const key of Object.keys(args)) {
    if (lines.length >= MAX_DETAIL_LINES) break
    lines.push(`${key}: ${truncate(renderValue(args[key]), DETAIL_VALUE_MAX_LENGTH)}`)
  }
  return lines
}

function firstStringArg(args: Readonly<Record<string, unknown>>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

function renderValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  // Never dump a whole file's content: an object/array argument (e.g.
  // edit's oldString/newString pair, if ever passed structured) is rendered
  // as JSON and then truncated the same as any other value, not expanded.
  return JSON.stringify(value)
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
