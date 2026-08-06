import { describe, expect, test } from 'bun:test'
import type { AssistantFacade } from '@qvac/assistant'
import type { HarnessAgentRegistration } from '@qvac/harness'
import {
  CODE_CLAIM_GATE_ID,
  CODE_EXECUTOR_CAPABILITY,
  CODE_SESSION_FORMAT,
  CODE_TURN_FORMAT,
  encodeSessionPayload,
  encodeTurnPayload,
  formatClaimDecision,
  formatSessionWorkId,
  formatTurnWorkId,
  parseClaimDecision,
  type CodeSessionPayload,
  type CodeTurnPayload
} from '@qvac-poc/qvac-code-shared'
import type {
  CodeExecutorRecord,
  CodeGateRecord,
  CodeMeshStore,
  CodeWorkRecord
} from '@qvac-poc/qvac-code-shared/store'
import type { ExecutorIdentity } from '../lib/executor-identity.ts'
import { createExecutor, type ExecutorDeps, type ExecutorEvent } from '../lib/executor.ts'
import type { createApprovalBridge } from '../lib/approval-bridge.ts'
import type { createTurnRunner, TurnRunnerInput, TurnRunResult } from '../lib/turn-runner.ts'

const IDENTITY: ExecutorIdentity = {
  executorId: 'code-host-abc123456789',
  hostname: 'host',
  projectRoot: '/tmp/qvac-code-executor-test-project',
  projectLabel: 'project'
}

// executor.ts writes its own bookkeeping entries with `seq = now() + nonce`
// (see the comment in executor.ts). A constant now() is fine for these
// tests: the fake store never rejects on a repeated seq the way a real
// operationId-deduping Sync store would.
function notImplemented(name: string) {
  return () => {
    throw new Error(`${name} is not implemented in this fake`)
  }
}

interface FakeGate {
  readonly gateId: string
  readonly kind: string
  decision: string | null
  readonly recordedAt: number
  readonly workId: string
}

function createFakeStore(
  options: { readonly claimTurn?: CodeMeshStore['claimTurn'] } = {}
) {
  const works = new Map<string, CodeWorkRecord>()
  const gatesByWorkId = new Map<string, FakeGate[]>()
  const executors = new Map<string, CodeExecutorRecord>()
  const appended: Parameters<CodeMeshStore['appendEntry']>[0][] = []
  const recordOutcomeCalls: Parameters<CodeMeshStore['recordOutcome']>[0][] = []
  const advertiseCalls: Parameters<CodeMeshStore['advertiseExecutor']>[0][] = []
  const openClaimGateCalls: Parameters<CodeMeshStore['openClaimGate']>[0][] = []
  let throwOnListGates: ReadonlySet<string> | null = null

  function gateList(workId: string) {
    const list = gatesByWorkId.get(workId)
    if (list) return list
    const created: FakeGate[] = []
    gatesByWorkId.set(workId, created)
    return created
  }

  function seedTurn(input: {
    readonly sessionId: string
    readonly seq: number
    readonly prompt: string
    readonly target?: string | null
    readonly cancelRequested?: boolean
    readonly outcomeStatus?: 'completed' | 'failed' | 'cancelled' | null
    readonly createdAt?: number
  }) {
    const workId = formatTurnWorkId({ sessionId: input.sessionId, seq: input.seq })
    const payload: CodeTurnPayload = {
      kind: 'code-turn',
      sessionId: input.sessionId,
      seq: input.seq,
      prompt: input.prompt,
      requestedBy: 'tester'
    }
    works.set(workId, {
      workId,
      payload: encodeTurnPayload(payload),
      payloadFormat: CODE_TURN_FORMAT,
      payloadVersion: 1,
      target: input.target ?? null,
      createdAt: input.createdAt ?? 0,
      cancelRequested: input.cancelRequested ?? false,
      outcomeStatus: input.outcomeStatus ?? null
    })
    return workId
  }

  function seedSession(input: { readonly sessionId: string; readonly outcomeStatus?: 'completed' | 'failed' | 'cancelled' | null }) {
    const workId = formatSessionWorkId(input.sessionId)
    const payload: CodeSessionPayload = {
      kind: 'code-session',
      title: 'Session',
      projectLabel: 'project',
      model: 'model',
      createdBy: 'tester'
    }
    works.set(workId, {
      workId,
      payload: encodeSessionPayload(payload),
      payloadFormat: CODE_SESSION_FORMAT,
      payloadVersion: 1,
      createdAt: 0,
      outcomeStatus: input.outcomeStatus ?? null
    })
    return workId
  }

  function seedClaim(workId: string, executorId: string) {
    gateList(workId).push({
      gateId: CODE_CLAIM_GATE_ID,
      kind: 'qvac.poc.code.claim/v1',
      decision: formatClaimDecision(executorId),
      recordedAt: 0,
      workId
    })
  }

  function seedExecutor(input: { readonly executorId: string; readonly expiresAt: number; readonly capabilities: readonly string[] }) {
    executors.set(input.executorId, {
      executorId: input.executorId,
      capabilities: [...input.capabilities],
      expiresAt: input.expiresAt,
      recordedAt: 0
    })
  }

  function flipClaim(workId: string, executorId: string) {
    const gate = gateList(workId).find((candidate) => candidate.gateId === CODE_CLAIM_GATE_ID)
    if (gate) gate.decision = formatClaimDecision(executorId)
  }

  const defaultClaimTurn: CodeMeshStore['claimTurn'] = async (input) => {
    const workId = formatTurnWorkId(input)
    const gate = gateList(workId).find((candidate) => candidate.gateId === CODE_CLAIM_GATE_ID)
    if (gate == null) return { kind: 'unreachable', error: new Error('claim gate missing') }
    if (gate.decision == null) gate.decision = formatClaimDecision(input.executorId)
    const claim = parseClaimDecision(gate.decision)
    if (claim == null) return { kind: 'unreachable', error: new Error('corrupt claim decision') }
    return claim.executorId === input.executorId ? { kind: 'won' } : { kind: 'lost', winner: claim.executorId }
  }

  const store: CodeMeshStore = {
    createSession: notImplemented('createSession'),
    createTurn: notImplemented('createTurn'),
    nextTurnSeq: notImplemented('nextTurnSeq'),
    listSessions: notImplemented('listSessions'),
    async getWork(workId) {
      return works.get(workId) ?? null
    },
    async listAvailableTurns() {
      return [...works.values()].filter(
        (work) => work.payloadFormat === CODE_TURN_FORMAT && !work.cancelRequested && work.outcomeStatus == null
      )
    },
    listJournal: notImplemented('listJournal'),
    async listGates(workId) {
      if (throwOnListGates?.has(workId)) throw new Error(`listGates failed for ${workId}`)
      return gateList(workId) as unknown as CodeGateRecord[]
    },
    listOpenGates: notImplemented('listOpenGates'),
    async openClaimGate(input) {
      openClaimGateCalls.push(input)
      const workId = formatTurnWorkId(input)
      const list = gateList(workId)
      if (!list.some((candidate) => candidate.gateId === CODE_CLAIM_GATE_ID)) {
        list.push({ gateId: CODE_CLAIM_GATE_ID, kind: 'qvac.poc.code.claim/v1', decision: null, recordedAt: 0, workId })
      }
    },
    async claimTurn(input) {
      return (options.claimTurn ?? defaultClaimTurn)(input)
    },
    openApprovalGate: notImplemented('openApprovalGate'),
    resolveApprovalGate: notImplemented('resolveApprovalGate'),
    async appendEntry(input) {
      appended.push(input)
    },
    requestCancel: notImplemented('requestCancel'),
    async recordOutcome(input) {
      recordOutcomeCalls.push(input)
      const work = works.get(input.workId)
      if (work) works.set(input.workId, { ...work, outcomeStatus: input.status })
      return { kind: 'recorded' }
    },
    async advertiseExecutor(input) {
      advertiseCalls.push(input)
      executors.set(input.executorId, {
        executorId: input.executorId,
        capabilities: [...(input.capabilities ?? [])],
        expiresAt: input.expiresAt,
        recordedAt: 0
      })
    },
    async listExecutors() {
      return [...executors.values()]
    },
    watchSessions: notImplemented('watchSessions'),
    watchTurnJournal: notImplemented('watchTurnJournal'),
    watchOpenGates: notImplemented('watchOpenGates')
  }

  return {
    store,
    appended,
    recordOutcomeCalls,
    advertiseCalls,
    openClaimGateCalls,
    seedTurn,
    seedSession,
    seedClaim,
    seedExecutor,
    flipClaim,
    setThrowOnListGates: (workIds: readonly string[]) => {
      throwOnListGates = new Set(workIds)
    }
  }
}

function createFakeTurnRunner(impl?: (input: TurnRunnerInput) => Promise<TurnRunResult>) {
  const calls: TurnRunnerInput[] = []
  const turnRunner: ReturnType<typeof createTurnRunner> = {
    async run(input) {
      calls.push(input)
      if (impl) return impl(input)
      // Deliberately never records an outcome: this fake stands in for
      // turn-runner.ts, which is unit-tested separately. Leaving the turn
      // "available" lets tests that need a *second* pass to re-evaluate the
      // same turn (e.g. proving claimedInThisProcess) do so without a
      // separate seam.
      return { status: 'completed', finalText: '', outcome: { kind: 'recorded' } }
    }
  }
  return { turnRunner, calls }
}

function createFakeApprovalBridge() {
  const trackCalls: Parameters<ReturnType<typeof createApprovalBridge>['track']>[0][] = []
  const releasedTurnWorkIds: string[] = []
  const closeTurnCalls: string[] = []
  const approvals: ReturnType<typeof createApprovalBridge> = {
    track(input) {
      trackCalls.push(input)
      return {
        release() {
          releasedTurnWorkIds.push(input.turnWorkId)
        }
      }
    },
    async start() {},
    async closeTurn(turnWorkId) {
      closeTurnCalls.push(turnWorkId)
    },
    async reconcile() {}
  }
  return { approvals, trackCalls, releasedTurnWorkIds, closeTurnCalls }
}

function createFakeAssistant() {
  const registerAgentCalls: HarnessAgentRegistration[] = []
  const cancelRunCalls: { readonly agentId: string; readonly runId: string; readonly reason?: string }[] = []
  const assistant: Pick<AssistantFacade, 'run' | 'cancelRun' | 'registerAgent'> = {
    run() {
      throw new Error('executor.ts must drive execution through turnRunner.run, not assistant.run directly')
    },
    async cancelRun(input) {
      cancelRunCalls.push(input)
    },
    async registerAgent(registration) {
      registerAgentCalls.push(registration)
    }
  }
  return { assistant, registerAgentCalls, cancelRunCalls }
}

// Every sleep -- the 500ms between-pass interval, the 2s confirmation
// barrier, the 30s presence interval -- collapses to a couple of real
// milliseconds here so the whole loop can run many times inside a test's
// polling window. Individual tests that need to react to a *specific*
// sleep duration (the confirmation barrier) match on the `ms` argument.
function createFastSleep(onSleep?: (ms: number) => void) {
  const calls: number[] = []
  const sleep = async (ms: number) => {
    calls.push(ms)
    onSleep?.(ms)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return { sleep, calls }
}

function createDeps(overrides: Partial<ExecutorDeps> = {}) {
  const storeFake = createFakeStore()
  const turnRunnerFake = createFakeTurnRunner()
  const approvalsFake = createFakeApprovalBridge()
  const assistantFake = createFakeAssistant()
  const sleepFake = createFastSleep()
  const events: ExecutorEvent[] = []

  const deps: ExecutorDeps = {
    store: storeFake.store,
    assistant: assistantFake.assistant,
    identity: IDENTITY,
    model: 'test-model',
    turnRunner: turnRunnerFake.turnRunner,
    approvals: approvalsFake.approvals,
    now: () => 0,
    sleep: sleepFake.sleep,
    onEvent: (event) => events.push(event),
    allowSecondExecutor: false,
    ...overrides
  }

  return { deps, storeFake, turnRunnerFake, approvalsFake, assistantFake, sleepFake, events }
}

async function driveRun(
  executor: ReturnType<typeof createExecutor>,
  condition: () => boolean,
  timeoutMs = 3_000
) {
  const controller = new AbortController()
  const running = executor.run(controller.signal)
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      controller.abort()
      await running
      throw new Error('driveRun timed out waiting for its condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  controller.abort()
  await running
}

describe('preflight', function () {
  test('refuses when a live peer already advertises the same project', async function () {
    const { deps, storeFake } = createDeps({ now: () => 500 })
    storeFake.seedExecutor({
      executorId: 'other-executor',
      expiresAt: 1_000,
      capabilities: [CODE_EXECUTOR_CAPABILITY, 'project/project']
    })
    const executor = createExecutor(deps)
    await expect(executor.preflight()).rejects.toThrow(/other-executor/)
  })

  test('allows when the conflicting peer has already expired', async function () {
    const { deps, storeFake } = createDeps({ now: () => 500 })
    storeFake.seedExecutor({
      executorId: 'other-executor',
      expiresAt: 100,
      capabilities: [CODE_EXECUTOR_CAPABILITY, 'project/project']
    })
    const executor = createExecutor(deps)
    await expect(executor.preflight()).resolves.toBeUndefined()
  })

  test('allows a live conflicting peer when allowSecondExecutor is set', async function () {
    const { deps, storeFake } = createDeps({ now: () => 500, allowSecondExecutor: true })
    storeFake.seedExecutor({
      executorId: 'other-executor',
      expiresAt: 1_000,
      capabilities: [CODE_EXECUTOR_CAPABILITY, 'project/project']
    })
    const executor = createExecutor(deps)
    await expect(executor.preflight()).resolves.toBeUndefined()
  })

  test('ignores its own advertisement', async function () {
    const { deps, storeFake } = createDeps({ now: () => 500 })
    storeFake.seedExecutor({
      executorId: IDENTITY.executorId,
      expiresAt: 1_000,
      capabilities: [CODE_EXECUTOR_CAPABILITY, 'project/project']
    })
    const executor = createExecutor(deps)
    await expect(executor.preflight()).resolves.toBeUndefined()
  })
})

describe('recoverOrphans', function () {
  test('marks a turn this executor owns as interrupted and failed, and never runs it', async function () {
    const { deps, storeFake, turnRunnerFake } = createDeps()
    const workId = storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'do it' })
    storeFake.seedClaim(workId, IDENTITY.executorId)

    const executor = createExecutor(deps)
    await executor.recoverOrphans()

    expect(storeFake.recordOutcomeCalls).toEqual([{ workId, status: 'failed' }])
    expect(storeFake.appended.some((entry) => entry.body.type === 'turn-interrupted')).toBe(true)
    expect(turnRunnerFake.calls).toHaveLength(0)
  })

  test('ignores a turn claimed by a different executor', async function () {
    const { deps, storeFake, turnRunnerFake } = createDeps()
    const workId = storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'do it' })
    storeFake.seedClaim(workId, 'someone-else')

    const executor = createExecutor(deps)
    await executor.recoverOrphans()

    expect(storeFake.recordOutcomeCalls).toHaveLength(0)
    expect(turnRunnerFake.calls).toHaveLength(0)
  })

  test('ignores an unclaimed turn', async function () {
    const { deps, storeFake } = createDeps()
    storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'do it' })

    const executor = createExecutor(deps)
    await executor.recoverOrphans()

    expect(storeFake.recordOutcomeCalls).toHaveLength(0)
  })
})

describe('the claim loop routes every decideClaimAction branch correctly', function () {
  test('skip: a turn targeted at a different executor is reported and left untouched', async function () {
    const { deps, storeFake, turnRunnerFake, events } = createDeps()
    storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'x', target: 'someone-else' })

    const executor = createExecutor(deps)
    await driveRun(executor, () => events.some((event) => event.kind === 'skipped'))

    expect(turnRunnerFake.calls).toHaveLength(0)
  })

  test('open-claim-gate -> attempt-claim -> execute: a fresh turn is claimed and run', async function () {
    const { deps, storeFake, turnRunnerFake, events } = createDeps()
    const workId = storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'hello' })

    const executor = createExecutor(deps)
    await driveRun(executor, () => turnRunnerFake.calls.length > 0)

    expect(storeFake.openClaimGateCalls).toHaveLength(1)
    expect(events.some((event) => event.kind === 'claimed' && event.turnWorkId === workId)).toBe(true)
    expect(turnRunnerFake.calls[0]?.turnWorkId).toBe(workId)
    expect(turnRunnerFake.calls[0]?.prompt).toBe('hello')
  })

  test("attempt-claim -> lost: another executor's claim wins the race", async function () {
    const fakeWithLoser = createFakeStore({
      claimTurn: async () => ({ kind: 'lost', winner: 'other-executor' })
    })
    fakeWithLoser.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'hello' })
    const { deps, events, turnRunnerFake } = createDeps({ store: fakeWithLoser.store })

    const executor = createExecutor(deps)
    await driveRun(executor, () => events.some((event) => event.kind === 'lost'))

    expect(turnRunnerFake.calls).toHaveLength(0)
  })

  test('attempt-claim -> unreachable: reported as an error, never executed', async function () {
    const fakeWithUnreachable = createFakeStore({
      claimTurn: async () => ({ kind: 'unreachable', error: new Error('no quorum') })
    })
    fakeWithUnreachable.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'hello' })
    const { deps, events, turnRunnerFake } = createDeps({ store: fakeWithUnreachable.store })

    const executor = createExecutor(deps)
    await driveRun(
      executor,
      () => events.some((event) => event.kind === 'error' && event.detail?.includes('unreachable'))
    )

    expect(turnRunnerFake.calls).toHaveLength(0)
  })

  test('record-interrupted: a claim this process did not win in this lifetime is never executed', async function () {
    const { deps, storeFake, turnRunnerFake } = createDeps()
    const workId = storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'hello' })
    storeFake.seedClaim(workId, IDENTITY.executorId)

    const executor = createExecutor(deps)
    await driveRun(executor, () => storeFake.recordOutcomeCalls.length > 0)

    expect(storeFake.recordOutcomeCalls).toEqual([{ workId, status: 'failed' }])
    expect(turnRunnerFake.calls).toHaveLength(0)
  })
})

test('the confirmation barrier abandons a turn whose claim gate flipped during the wait', async function () {
  const { deps, storeFake, turnRunnerFake, events, sleepFake } = createDeps()
  const workId = storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'hello' })
  void sleepFake

  let flipped = false
  const { sleep } = createFastSleep((ms) => {
    // 2_000 is executor.ts's CONFIRMATION_BARRIER_MS. Flipping the claim
    // here simulates a concurrent device's resolve-gate merging in during
    // the barrier -- the exact race the barrier exists to catch.
    if (ms === 2_000 && !flipped) {
      flipped = true
      storeFake.flipClaim(workId, 'other-executor')
    }
  })

  const executor = createExecutor({ ...deps, sleep })
  await driveRun(executor, () => events.some((event) => event.kind === 'lost' && event.turnWorkId === workId))

  expect(turnRunnerFake.calls).toHaveLength(0)
  expect(storeFake.appended.some((entry) => entry.body.type === 'turn-superseded')).toBe(true)
})

test('claimedInThisProcess is set on a win, so a later re-evaluation still executes (never record-interrupted)', async function () {
  const { deps, storeFake, turnRunnerFake, events } = createDeps()
  storeFake.seedTurn({ sessionId: 'session-1', seq: 0, prompt: 'hello' })

  const executor = createExecutor(deps)
  // The fake turnRunner never records an outcome, so the turn stays
  // "available" and a second pass re-evaluates it. Reaching a *second*
  // turnRunner.run call is only possible via 'execute' -- 'record-interrupted'
  // would instead call recordOutcome('failed') and stop for good.
  await driveRun(executor, () => turnRunnerFake.calls.length >= 2)

  expect(events.some((event) => event.kind === 'orphan')).toBe(false)
  expect(storeFake.recordOutcomeCalls.some((call) => call.status === 'failed')).toBe(false)
})

test('a per-turn throw is reported but does not stop the loop from reaching other turns', async function () {
  const { deps, storeFake, events } = createDeps()
  const badWorkId = storeFake.seedTurn({ sessionId: 'session-bad', seq: 0, prompt: 'x' })
  const goodWorkId = storeFake.seedTurn({
    sessionId: 'session-good',
    seq: 0,
    prompt: 'y',
    target: 'someone-else'
  })
  storeFake.setThrowOnListGates([badWorkId])

  const executor = createExecutor(deps)
  await driveRun(
    executor,
    () =>
      events.some((event) => event.kind === 'error' && event.turnWorkId === badWorkId) &&
      events.some((event) => event.kind === 'skipped' && event.turnWorkId === goodWorkId)
  )
})
